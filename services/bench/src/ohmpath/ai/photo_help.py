"""Ephemeral photo-help jobs, separate from circuit sessions and evidence."""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import os
import struct
import tempfile
import threading
import zlib
from collections import OrderedDict
from pathlib import Path
from uuid import UUID, uuid4

from ohmpath.session.store import DomainError

from .live_proof import ProofFailure
from .photo_runtime import run_photo_turn

MAX_IMAGE_BYTES = 2_000_000
MAX_PIXELS = 8_000_000


def _bad_image() -> DomainError:
    return DomainError("photo_image_invalid", "Choose a valid PNG or JPEG up to 2 MB and 8 megapixels.", 422)


def _png_dimensions(raw: bytes) -> tuple[int, int]:
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise _bad_image()
    position = 8
    dimensions: tuple[int, int] | None = None
    saw_data = False
    saw_palette = False
    ended = False
    compressed = bytearray()
    while position + 12 <= len(raw):
        length = int.from_bytes(raw[position:position + 4], "big")
        kind = raw[position + 4:position + 8]
        end = position + 12 + length
        if length > MAX_IMAGE_BYTES or end > len(raw):
            raise _bad_image()
        data = raw[position + 8:position + 8 + length]
        expected_crc = int.from_bytes(raw[position + 8 + length:end], "big")
        if zlib.crc32(kind + data) != expected_crc:
            raise _bad_image()
        if dimensions is None:
            if kind != b"IHDR" or length != 13:
                raise _bad_image()
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            if (not width or not height or width * height > MAX_PIXELS or depth != 8
                    or color not in (0, 2, 3, 4, 6) or compression or filtering or interlace):
                raise _bad_image()
            dimensions = (width, height)
        elif kind == b"PLTE":
            if length < 3 or length % 3 or length > 768 or saw_data:
                raise _bad_image()
            saw_palette = True
        elif kind == b"IDAT":
            saw_data = True
            compressed.extend(data)
        elif kind == b"IEND":
            if length or end != len(raw):
                raise _bad_image()
            ended = True
            break
        elif not all(65 <= char <= 90 or 97 <= char <= 122 for char in kind):
            raise _bad_image()
        position = end
    if dimensions is None or not saw_data or not ended or (color == 3 and not saw_palette):
        raise _bad_image()
    width, height = dimensions
    # A bounded inflate catches truncated/corrupt IDAT and decompression bombs.
    max_uncompressed = (width * 4 + 1) * height + 1
    inflater = zlib.decompressobj()
    try:
        decoded = inflater.decompress(bytes(compressed), max_uncompressed)
        decoded += inflater.flush(max_uncompressed - len(decoded))
    except (zlib.error, ValueError):
        raise _bad_image() from None
    expected = (width * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color] + 1) * height
    stride = expected // height
    if (not inflater.eof or inflater.unused_data or len(decoded) != expected
            or any(decoded[row * stride] > 4 for row in range(height))):
        raise _bad_image()
    return dimensions


def _jpeg_dimensions(raw: bytes) -> tuple[int, int]:
    if not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"):
        raise _bad_image()
    position = 2
    dimensions: tuple[int, int] | None = None
    saw_scan = False
    while position + 1 < len(raw):
        if raw[position] != 0xFF:
            raise _bad_image()
        while position < len(raw) and raw[position] == 0xFF:
            position += 1
        if position >= len(raw):
            raise _bad_image()
        marker = raw[position]
        position += 1
        if marker == 0xD9:
            break
        if marker in range(0xD0, 0xD8) or marker in (0x00, 0x01, 0xD8):
            raise _bad_image()
        if position + 2 > len(raw):
            raise _bad_image()
        length = int.from_bytes(raw[position:position + 2], "big")
        if length < 2 or position + length > len(raw):
            raise _bad_image()
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 8 or raw[position + 2] != 8:
                raise _bad_image()
            height = int.from_bytes(raw[position + 3:position + 5], "big")
            width = int.from_bytes(raw[position + 5:position + 7], "big")
            if not width or not height or width * height > MAX_PIXELS:
                raise _bad_image()
            dimensions = (width, height)
        if marker == 0xDA:
            saw_scan = True
            position += length
            # In entropy data FF00 is escaped and restart markers are legal.
            while position < len(raw) - 1:
                marker_start = raw.find(b"\xff", position)
                if marker_start < 0 or marker_start >= len(raw) - 1:
                    raise _bad_image()
                code = raw[marker_start + 1]
                if code == 0x00 or 0xD0 <= code <= 0xD7:
                    position = marker_start + 2
                    continue
                position = marker_start
                break
            continue
        position += length
    if dimensions is None or not saw_scan or position != len(raw):
        raise _bad_image()
    return dimensions


def decode_image(image_base64: str, mime_type: str) -> bytes:
    if not isinstance(image_base64, str) or len(image_base64) > 2_700_000:
        raise _bad_image()
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (ValueError, binascii.Error):
        raise _bad_image() from None
    if not 32 <= len(raw) <= MAX_IMAGE_BYTES:
        raise _bad_image()
    if mime_type == "image/png":
        _png_dimensions(raw)
    elif mime_type == "image/jpeg":
        _jpeg_dimensions(raw)
    else:
        raise _bad_image()
    return raw


def _uuid(value: str) -> str:
    try:
        parsed = UUID(value)
        if str(parsed) != value.lower():
            raise ValueError
        return str(parsed)
    except (ValueError, TypeError, AttributeError):
        raise DomainError("photo_context_invalid", "Use a valid photo context and image ID.", 422) from None


class PhotoHelp:
    def __init__(self, runner=run_photo_turn):
        self.runner = runner
        self.lock = threading.RLock()
        self.jobs: OrderedDict[str, dict] = OrderedDict()
        self.contexts: OrderedDict[str, dict] = OrderedDict()
        self.cancelled_contexts: OrderedDict[str, None] = OrderedDict()
        self.closed = False

    def busy(self) -> bool:
        with self.lock:
            return any(job["worker"].is_alive() for job in self.jobs.values())

    def start(self, context_id: str, question: str, images: list[dict]) -> dict:
        context_id = _uuid(context_id)
        if not isinstance(question, str) or not 1 <= len(question.strip()) <= 4000:
            raise DomainError("photo_question_invalid", "Ask a question of up to 4000 characters.", 422)
        if not isinstance(images, list) or not 1 <= len(images) <= 3:
            raise DomainError("photo_images_invalid", "Select one to three images.", 422)
        decoded: list[tuple[str, str, bytes]] = []
        ids: set[str] = set()
        for image in images:
            if not isinstance(image, dict) or set(image) != {"image_id", "mime_type", "image_base64"}:
                raise _bad_image()
            image_id = _uuid(image["image_id"])
            if image_id in ids:
                raise DomainError("photo_image_duplicate", "Each selected image needs a unique ID.", 422)
            ids.add(image_id)
            raw = decode_image(image["image_base64"], image["mime_type"])
            decoded.append((image_id, image["mime_type"], raw))
        revision = hashlib.sha256(json.dumps(
            [(image_id, hashlib.sha256(raw).hexdigest()) for image_id, _, raw in decoded],
            separators=(",", ":")).encode()).hexdigest()
        with self.lock:
            if self.closed:
                raise DomainError("photo_unavailable", "Photo help is unavailable.", 503)
            if context_id in self.cancelled_contexts:
                raise DomainError("photo_context_cancelled", "Choose the images again to start a new request.", 409)
            if self.busy():
                raise DomainError("investigator_busy", "Wait for or cancel the current help request.", 429)
            context = self.contexts.get(context_id)
            if context is None or context["revision"] != revision:
                history: list[tuple[str, str]] = []
                for job in self.jobs.values():
                    if job["context_id"] == context_id and job["result"]["status"] == "completed":
                        job["result"] = {"turn_id": job["turn_id"], "status": "stale",
                                         "context_id": context_id, "image_revision": job["revision"]}
            else:
                history = context["history"][-3:]
            self.contexts[context_id] = {"revision": revision, "history": history}
            self.contexts.move_to_end(context_id)
            while len(self.contexts) > 32:
                self.contexts.popitem(last=False)
            turn_id = str(uuid4())
            cancel = threading.Event()
            result = {"turn_id": turn_id, "status": "running", "context_id": context_id,
                      "image_revision": revision}
            job = {"turn_id": turn_id, "context_id": context_id, "revision": revision,
                   "question": question, "images": decoded, "history": history,
                   "cancel": cancel, "result": result}
            worker = threading.Thread(target=self._work, args=(job,), daemon=True)
            job["worker"] = worker
            self.jobs[turn_id] = job
            while len(self.jobs) > 32:
                self.jobs.popitem(last=False)
            worker.start()
            return copy.deepcopy(result)

    def _work(self, job: dict) -> None:
        try:
            with tempfile.TemporaryDirectory(prefix="ohmpath-photo-images-") as directory:
                os.chmod(directory, 0o700)
                paths = []
                for index, (image_id, mime_type, raw) in enumerate(job["images"]):
                    path = Path(directory) / f"image-{index}{'.png' if mime_type == 'image/png' else '.jpg'}"
                    path.write_bytes(raw)
                    paths.append((image_id, path))
                job["images"] = None
                answer = self.runner(job["context_id"], job["revision"], job["question"],
                                     paths, job["history"], job["cancel"])
            # Validate even an injected runner; only the validated shape reaches UI.
            from .photo_runtime import validate_answer
            checked = validate_answer(json.dumps({"context_id": job["context_id"],
                "image_revision": job["revision"], "answer": answer}),
                job["context_id"], job["revision"], {image_id for image_id, _ in paths})
            with self.lock:
                context = self.contexts.get(job["context_id"])
                if self.closed or job["cancel"].is_set() or context is None or context["revision"] != job["revision"]:
                    return
                job["result"] = {"turn_id": job["turn_id"], "status": "completed",
                                 "context_id": job["context_id"], "image_revision": job["revision"],
                                 "answer": checked}
                context["history"].append((job["question"][:4000], checked["explanation"][:2000]))
                context["history"] = context["history"][-3:]
        except Exception as error:
            with self.lock:
                if self.closed or job["cancel"].is_set():
                    return
                allowed = {"not_chatgpt_subscription", "astra_capability_unavailable",
                           "allowance_margin_reached", "ordinary_subscription_usage_unavailable",
                           "codex_allowance_unavailable", "codex_version_mismatch",
                           "codex_config_unavailable", "turn_timeout", "invalid_model_output",
                           "stale_photo_output", "unexpected_server_request",
                           "disallowed_model_action_observed", "effective_config_not_restricted",
                           "unexpected_mcp_server_inventory", "model_or_permission_rerouted"}
                code = str(error) if isinstance(error, ProofFailure) and str(error) in allowed else "photo_help_failed"
                job["result"] = {"turn_id": job["turn_id"], "status": "failed",
                                 "context_id": job["context_id"], "image_revision": job["revision"],
                                 "error": code, "message": "Photo help stopped without a validated answer. Please retry."}
        finally:
            job["images"] = None

    def status(self, turn_id: str) -> dict:
        with self.lock:
            job = self.jobs.get(turn_id)
            if job is None:
                raise DomainError("photo_turn_not_found", "This photo-help turn is unavailable.", 404)
            return copy.deepcopy(job["result"])

    def cancel(self, context_id: str, turn_id: str | None = None) -> dict:
        context_id = _uuid(context_id)
        with self.lock:
            if turn_id is not None and (turn_id not in self.jobs or self.jobs[turn_id]["context_id"] != context_id):
                raise DomainError("photo_turn_not_found", "This photo-help turn is unavailable.", 404)
            if turn_id is None:
                self.cancelled_contexts[context_id] = None
                self.cancelled_contexts.move_to_end(context_id)
                while len(self.cancelled_contexts) > 128:
                    self.cancelled_contexts.popitem(last=False)
                self.contexts.pop(context_id, None)
            for job in self.jobs.values():
                if job["context_id"] == context_id and (turn_id is None or job["turn_id"] == turn_id):
                    if job["result"]["status"] == "running":
                        job["cancel"].set()
                        job["result"] = {"turn_id": job["turn_id"], "status": "cancelled",
                                         "context_id": context_id, "image_revision": job["revision"]}
                    elif turn_id is None and job["result"]["status"] == "completed":
                        job["result"] = {"turn_id": job["turn_id"], "status": "stale",
                                         "context_id": context_id, "image_revision": job["revision"]}
            return self.status(turn_id) if turn_id else {"status": "cancelled", "context_id": context_id}

    def close(self) -> None:
        with self.lock:
            self.closed = True
            workers = []
            for job in self.jobs.values():
                job["cancel"].set()
                workers.append(job["worker"])
        for worker in workers:
            if worker is not threading.current_thread():
                worker.join(timeout=5)
