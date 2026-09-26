"""Local investigation lifecycle; model work never owns physical acceptance."""

from __future__ import annotations

import copy
import re
import threading
from collections import OrderedDict

from ohmpath.session.store import DomainError, SessionStore, opaque_id

from .runtime import run_investigation


class Investigations:
    def __init__(self, store: SessionStore, model_token: str | None, runner=run_investigation):
        self.store, self.model_token, self.runner = store, model_token, runner
        self.base_url: str | None = None
        self.lock = threading.RLock()
        self.jobs: OrderedDict[str, dict] = OrderedDict()
        self.closed = False

    def start(self, sid: str, question: str) -> dict:
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
            job = {"sid": sid, "state": state, "cancel": cancel, "result": result}
            def record_start(current, emit):
                if current["status"] != "active" or current["revisions"] != state["revisions"] or current["arming_epoch"] != state["arming_epoch"]:
                    raise DomainError("investigation_context_changed", "The bench changed before this investigation started.")
                emit("investigation.started", {"turn_id": turn_id, "question": question}, source="user")
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
            value = self.runner(self.base_url, self.model_token, job["sid"],
                                state["revisions"]["circuit_revision"], question, cancel_event=cancel)
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
                code = error.code if isinstance(error, DomainError) else str(error)
                # Provider output and exception details cannot leak private configuration.
                if not re.fullmatch(r"[a-z_]+(?::[a-zA-Z/]+)?", code):
                    code = "investigation_failed"
                job["result"] = {"turn_id": turn_id, "status": "failed", "error": code}
                self.store.transact(job["sid"], lambda current, emit: emit(
                    "investigation.failed", {"turn_id": turn_id, "error": code}))

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
            for job in self.jobs.values():
                job["cancel"].set()
