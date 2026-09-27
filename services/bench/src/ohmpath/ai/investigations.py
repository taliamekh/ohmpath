"""Local investigation lifecycle; model work never owns physical acceptance."""

from __future__ import annotations

import copy
import hashlib
import os
import re
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

from ohmpath.session.store import DomainError, SessionStore, opaque_id
from ohmpath.vision.ocr import MAX_IMAGE_BYTES, _image_suffix

from .runtime import run_investigation
from .codex import ProtocolError
from .live_proof import ProofFailure


SAFE_FAILURE_MESSAGES = {
    "not_chatgpt_subscription": "Sign in to Codex with the existing ChatGPT subscription, then retry. API billing is not used.",
    "astra_capability_unavailable": "The selected Astra model is unavailable on this account. No model was substituted.",
    "allowance_margin_reached": "Subscription allowance is near its reserved margin. Continue with local tools or wait for the allowance to renew.",
    "ordinary_subscription_usage_unavailable": "Subscription use is currently unavailable. No paid fallback was started.",
    "codex_allowance_unavailable": "The subscription allowance could not be verified. Retry after checking the signed-in account.",
    "codex_version_mismatch": "This Codex CLI version has not been verified by this build. Review the adapter version before retrying.",
    "codex_executable_unavailable": "Ohm Path could not find or start the installed Codex program. Check the local Codex installation, then reopen Ohm Path.",
    "codex_config_unavailable": "The local signed-in Codex configuration is unavailable.",
    "turn_timeout": "The investigation reached its time limit without a validated answer. You can narrow the question and try again.",
    "stale_or_unlinked_model_output": "The answer did not cite valid current evidence and was discarded. Review the circuit and retry.",
    "required_tool_loop_missing": "The investigation did not complete all required evidence checks, so its answer was discarded.",
    "invalid_model_output": "The response did not pass the evidence format checks and was discarded.",
    "model_or_permission_rerouted": "The requested model or permission settings changed. The investigation stopped.",
    "effective_config_not_restricted": "The required tool restrictions could not be verified. The investigation stopped.",
    "unexpected_mcp_server_inventory": "Unexpected tool access was detected. The investigation stopped before producing advice.",
}


class Investigations:
    def __init__(self, store: SessionStore, model_token: str | None, runner=run_investigation):
        self.store, self.model_token, self.runner = store, model_token, runner
        self.base_url: str | None = None
        self.lock = threading.RLock()
        self.jobs: OrderedDict[str, dict] = OrderedDict()
        self.closed = False

    def start(self, sid: str, question: str, *, image_bytes: bytes | None = None) -> dict:
        image_suffix: str | None = None
        image_sha256: str | None = None
        image_snapshot: bytes | None = None
        if image_bytes is not None:
            if not isinstance(image_bytes, bytes) or not 32 <= len(image_bytes) <= MAX_IMAGE_BYTES:
                raise DomainError("investigation_image_invalid", "Image must be PNG or JPEG and no larger than 2 MB.", 422)
            try:
                image_suffix = _image_suffix(image_bytes)
            except ValueError:
                raise DomainError("investigation_image_invalid", "Image must have a valid bounded PNG or JPEG header.", 422) from None
            image_snapshot = bytes(image_bytes)
            image_sha256 = hashlib.sha256(image_snapshot).hexdigest()
        state = self.store.get(sid)
        if state["status"] != "active":
            raise DomainError("session_paused", "Select a circuit or review setup to resume this bench.")
        with self.lock:
            if self.closed or not self.base_url or not self.model_token:
                raise DomainError("investigator_unavailable", "The subscription investigator is unavailable in this service.")
            if any(j["worker"].is_alive() for j in self.jobs.values()):
                raise DomainError("investigator_busy", "Wait for or cancel the current investigation.", 429)
            turn_id = opaque_id()
            cancel = threading.Event()
            result = {"turn_id": turn_id, "status": "running"}
            job = {"sid": sid, "state": state, "cancel": cancel, "result": result,
                   "image_bytes": image_snapshot, "image_suffix": image_suffix}
            def record_start(current, emit):
                if current["status"] != "active" or current["revisions"] != state["revisions"] or current["arming_epoch"] != state["arming_epoch"]:
                    raise DomainError("investigation_context_changed", "The bench changed before this investigation started.")
                metadata = {"turn_id": turn_id, "question": question}
                if image_snapshot is not None:
                    metadata.update(image_attached=True, image_sha256=image_sha256)
                emit("investigation.started", metadata, source="user")
            self.store.transact(sid, record_start)
            worker = threading.Thread(target=self._work, args=(turn_id, question), daemon=True)
            job["worker"] = worker
            self.jobs[turn_id] = job
            while len(self.jobs) > 32:
                self.jobs.popitem(last=False)
            worker.start()
            return copy.deepcopy(result)

    def _work(self, turn_id: str, question: str):
        job = self.jobs[turn_id]
        state, cancel = job["state"], job["cancel"]
        try:
            image_bytes = job.get("image_bytes")
            image_suffix = job.get("image_suffix")
            if image_bytes is None:
                value = self.runner(self.base_url, self.model_token, job["sid"],
                                    state["revisions"]["circuit_revision"], question, cancel_event=cancel)
            else:
                with tempfile.TemporaryDirectory(prefix="ohmpath-investigation-image-") as directory:
                    os.chmod(directory, 0o700)
                    image_path = Path(directory) / f"reviewed-image{image_suffix}"
                    image_path.write_bytes(image_bytes)
                    value = self.runner(self.base_url, self.model_token, job["sid"],
                                        state["revisions"]["circuit_revision"], question,
                                        cancel_event=cancel, image_path=image_path)
            with self.lock:
                if self.closed or cancel.is_set():
                    return
                def record(current, emit):
                    if (current["revisions"] != state["revisions"] or current["status"] != "active"
                            or current["arming_epoch"] != state["arming_epoch"]):
                        raise DomainError("investigation_context_changed", "The bench changed during this investigation.")
                    emit("investigation.completed", {"turn_id": turn_id, **value}, source="model")
                self.store.transact(job["sid"], record)
                job["result"] = {"turn_id": turn_id, "status": "completed", **value}
        except Exception as error:
            with self.lock:
                if self.closed or cancel.is_set():
                    return
                # Never echo runner/provider messages; they may contain a private file path.
                code = error.code if isinstance(error, DomainError) else "investigation_failed"
                if isinstance(error, (ProofFailure, ProtocolError)) and str(error) in SAFE_FAILURE_MESSAGES:
                    code = str(error)
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]+(?::[a-zA-Z/]+)?", code):
                    code = "investigation_failed"
                message = SAFE_FAILURE_MESSAGES.get(code, "The investigation stopped without a validated answer. Your accepted readings are preserved.")
                job["result"] = {"turn_id": turn_id, "status": "failed", "error": code, "message": message}
                self.store.transact(job["sid"], lambda current, emit: emit(
                    "investigation.failed", {"turn_id": turn_id, "error": code}))
        finally:
            job["image_bytes"] = None
            job["image_suffix"] = None

    def status(self, sid: str, turn_id: str) -> dict:
        with self.lock:
            job = self.jobs.get(turn_id)
            if job is None or job["sid"] != sid:
                raise DomainError("investigation_not_found", "This investigation is unavailable.", 404)
            return copy.deepcopy(job["result"])

    def cancel(self, sid: str, turn_id: str | None = None) -> dict:
        with self.lock:
            if turn_id is not None:
                self.status(sid, turn_id)
            for key, job in self.jobs.items():
                if job["sid"] == sid and (turn_id is None or key == turn_id) and job["result"]["status"] == "running":
                    job["cancel"].set()
                    job["result"] = {"turn_id": key, "status": "cancelled"}
                    self.store.transact(sid, lambda current, emit: emit("investigation.cancelled", {"turn_id": key}))
            return self.status(sid, turn_id) if turn_id else {"status": "cancelled"}

    def close(self):
        with self.lock:
            self.closed = True
            workers = []
            for job in self.jobs.values():
                job["cancel"].set()
                workers.append(job.get("worker"))
        for worker in workers:
            if worker is not None and worker is not threading.current_thread():
                # Give cancellation-aware runners a chance to leave their
                # TemporaryDirectory before application shutdown proceeds.
                worker.join(timeout=5.0)
