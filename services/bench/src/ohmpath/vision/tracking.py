"""Bounded, local image quality and user-selected point tracking.

Coordinates refer only to the decoded image. They are visual observations,
never component identities, measurements, calibration, or device commands.
"""

from __future__ import annotations

import math
import threading
import time
import zlib
from dataclasses import dataclass
from uuid import UUID

import cv2
import numpy as np

MAX_IMAGE_BYTES = 512 * 1024
MAX_WIDTH = 1280
MAX_HEIGHT = 960
MAX_SEQUENCE = 2_147_483_647
MAX_CONTEXTS = 2
STALE_SECONDS = 2.0
PATCH_RADIUS = 16
SEARCH_RADIUS = 48
MIN_TEXTURE_STD = 12.0
MIN_MATCH = 0.78
MIN_MATCH_MARGIN = 0.04


def _dimensions(raw: bytes) -> tuple[int, int]:
    """Reject oversized dimensions and incomplete headers before decoding."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        if (len(raw) < 45 or raw[8:12] != b"\x00\x00\x00\x0d"
                or raw[12:16] != b"IHDR" or raw[-12:-8] != b"\x00\x00\x00\x00"
                or raw[-8:-4] != b"IEND" or raw[-4:] != b"\xaeB`\x82"):
            raise ValueError("Image has an incomplete PNG header.")
        if zlib.crc32(raw[12:29]) != int.from_bytes(raw[29:33], "big"):
            raise ValueError("Image has an invalid PNG header.")
        width = int.from_bytes(raw[16:20], "big")
        height = int.from_bytes(raw[20:24], "big")
        if (raw[24] != 8 or raw[25] not in (0, 2, 3, 4, 6)
                or raw[26:29] != b"\x00\x00\x00"):
            raise ValueError("Image uses an unsupported PNG format.")
    elif raw.startswith(b"\xff\xd8") and raw.endswith(b"\xff\xd9"):
        position = 2
        dimensions = None
        saw_scan = False
        while position + 3 < len(raw):
            if raw[position] != 0xFF:
                raise ValueError("Image has an invalid JPEG header.")
            while position < len(raw) and raw[position] == 0xFF:
                position += 1
            if position >= len(raw):
                break
            marker = raw[position]
            position += 1
            if marker in (0xD8, 0xD9, 0x00) or 0xD0 <= marker <= 0xD7:
                raise ValueError("Image has an invalid JPEG header.")
            if position + 2 > len(raw):
                break
            length = int.from_bytes(raw[position:position + 2], "big")
            if length < 2 or position + length > len(raw):
                raise ValueError("Image has an incomplete JPEG header.")
            if marker in (0xC0, 0xC1, 0xC2):
                if dimensions is not None or length < 8 or raw[position + 2] != 8:
                    raise ValueError("Image has an invalid JPEG frame header.")
                height = int.from_bytes(raw[position + 3:position + 5], "big")
                width = int.from_bytes(raw[position + 5:position + 7], "big")
                if not 1 <= width <= MAX_WIDTH or not 1 <= height <= MAX_HEIGHT:
                    raise ValueError("Image dimensions exceed the tracking limit.")
                dimensions = (width, height)
            if marker == 0xDA:
                saw_scan = True
                break
            position += length
        if dimensions is None or not saw_scan:
            raise ValueError("Image has an incomplete JPEG header.")
        width, height = dimensions
    else:
        raise ValueError("Image must be PNG or JPEG.")
    if not 1 <= width <= MAX_WIDTH or not 1 <= height <= MAX_HEIGHT:
        raise ValueError("Image dimensions exceed the tracking limit.")
    return width, height


def _decode(image: bytes) -> np.ndarray:
    if not isinstance(image, bytes) or not 32 <= len(image) <= MAX_IMAGE_BYTES:
        raise ValueError("Image must be PNG or JPEG and no larger than 512 KB.")
    width, height = _dimensions(image)
    gray = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None or gray.ndim != 2 or gray.shape != (height, width):
        raise ValueError("Image could not be decoded at its declared dimensions.")
    return gray


def _bounded(value: float) -> float:
    return round(max(0.0, min(1.0, float(value))), 3)


def _quality(gray: np.ndarray) -> dict[str, float]:
    height, width = gray.shape
    factor = min(1.0, 320 / max(height, width))
    small = (cv2.resize(gray, (max(1, round(width * factor)), max(1, round(height * factor))),
                        interpolation=cv2.INTER_AREA) if factor < 1 else gray)
    return {
        "brightness": _bounded(float(small.mean()) / 255),
        "contrast": _bounded(float(small.std()) / 64),
        "sharpness": _bounded(float(cv2.Laplacian(small, cv2.CV_32F).var()) / 500),
        "texture": 0.0,
        "match": 0.0,
    }


def _point_pixels(point: tuple[float, float] | None, width: int, height: int) -> tuple[int, int] | None:
    if point is None:
        return None
    if (not isinstance(point, (tuple, list)) or len(point) != 2
            or any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) or not 0 <= value <= 1 for value in point)):
        raise ValueError("Point must contain two normalized coordinates.")
    return round(point[0] * (width - 1)), round(point[1] * (height - 1))


@dataclass
class _State:
    source: str
    width: int
    height: int
    sequence: int
    seen_at: float
    status: str
    center: tuple[int, int] | None = None
    template: np.ndarray | None = None


class VisualTracker:
    """Tracks one explicitly selected textured patch per context, in memory."""

    def __init__(self) -> None:
        self._contexts: dict[str, _State] = {}
        self._lock = threading.Lock()

    def reset(self, context_id: str) -> None:
        with self._lock:
            self._contexts.pop(_context_id(context_id), None)

    def process(
        self, *, context_id: str, source: str, sequence: int, image: bytes,
        point: tuple[float, float] | None = None, now: float | None = None,
    ) -> dict:
        with self._lock:
            return self._process(context_id=context_id, source=source, sequence=sequence,
                                 image=image, point=point, now=now)

    def _process(
        self, *, context_id: str, source: str, sequence: int, image: bytes,
        point: tuple[float, float] | None, now: float | None,
    ) -> dict:
        context_id = _context_id(context_id)
        if source not in ("overview", "pi"):
            raise ValueError("Source must be overview or pi.")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= MAX_SEQUENCE:
            raise ValueError("Sequence must be a positive bounded integer.")
        instant = time.monotonic() if now is None else now
        if isinstance(instant, bool) or not isinstance(instant, (int, float)) or not math.isfinite(instant) or instant < 0:
            raise ValueError("Time must be a finite monotonic value.")
        previous = self._contexts.get(context_id)
        if previous and (sequence <= previous.sequence or instant < previous.seen_at):
            raise ValueError("Frame sequence or time moved backwards.")
        gray = _decode(image)
        height, width = gray.shape
        selected = _point_pixels(point, width, height)
        quality = _quality(gray)
        if previous is None and len(self._contexts) >= MAX_CONTEXTS:
            expired = [key for key, state in self._contexts.items() if instant - state.seen_at > STALE_SECONDS]
            for key in expired:
                del self._contexts[key]
            if len(self._contexts) >= MAX_CONTEXTS:
                raise ValueError("At most two visual contexts may be active.")

        state = _State(source, width, height, sequence, float(instant), "idle")
        self._contexts[context_id] = state

        def result(status: str, message: str, center: tuple[int, int] | None = None) -> dict:
            state.status = status
            state.center = center if status == "tracking" else None
            if status != "tracking":
                state.template = None
            target = ({"x": round(center[0] / (width - 1), 6), "y": round(center[1] / (height - 1), 6)}
                      if status == "tracking" and center and width > 1 and height > 1 else None)
            return {"context_id": context_id, "source": source, "sequence": sequence,
                    "status": status, "target": target, "quality": quality, "message": message}

        if selected is not None:
            x, y = selected
            if (x < PATCH_RADIUS or y < PATCH_RADIUS
                    or x + PATCH_RADIUS >= width or y + PATCH_RADIUS >= height):
                return result("lost", "Selected point is too close to the image edge.")
            template = gray[y - PATCH_RADIUS:y + PATCH_RADIUS + 1,
                            x - PATCH_RADIUS:x + PATCH_RADIUS + 1].copy()
            texture = float(template.std())
            quality["texture"] = _bounded(texture / 48)
            if texture < MIN_TEXTURE_STD:
                return result("lost", "Selected point lacks enough visual detail; select another point.")
            state.template = template
            quality["match"] = 1.0
            return result("tracking", "Selected point is tracked in this image.", (x, y))

        if previous is None:
            return result("idle", "Select a point to start local visual tracking.")
        if previous.source != source or previous.width != width or previous.height != height:
            return result("lost", "Camera source or image size changed; select the point again.")
        if instant - previous.seen_at > STALE_SECONDS:
            return result("lost", "The previous frame is stale; select the point again.")
        if previous.status != "tracking" or previous.center is None or previous.template is None:
            return result("lost" if previous.status == "lost" else "idle",
                          "Tracking needs a new point selection." if previous.status == "lost"
                          else "Select a point to start local visual tracking.")

        x, y = previous.center
        radius = PATCH_RADIUS
        x0 = max(0, x - radius - SEARCH_RADIUS)
        y0 = max(0, y - radius - SEARCH_RADIUS)
        x1 = min(width, x + radius + SEARCH_RADIUS + 1)
        y1 = min(height, y + radius + SEARCH_RADIUS + 1)
        search = gray[y0:y1, x0:x1]
        if search.shape[0] < previous.template.shape[0] or search.shape[1] < previous.template.shape[1]:
            return result("lost", "Selected point left the image; select it again.")
        scores = cv2.matchTemplate(search, previous.template, cv2.TM_CCOEFF_NORMED)
        _, score, _, location = cv2.minMaxLoc(scores)
        quality["match"] = _bounded(score)
        if not math.isfinite(score) or score < MIN_MATCH:
            return result("lost", "The selected point is no longer visually matched; select it again.")
        masked = scores.copy()
        cv2.circle(masked, location, 5, -1, thickness=-1)
        other = float(masked.max()) if masked.size else -1.0
        if other > score - MIN_MATCH_MARGIN:
            return result("lost", "The selected patch matches multiple places; select a clearer point.")
        center = (x0 + location[0] + radius, y0 + location[1] + radius)
        cx, cy = center
        if cx < radius or cy < radius or cx + radius >= width or cy + radius >= height:
            return result("lost", "Selected point left the image; select it again.")
        candidate = gray[cy - radius:cy + radius + 1, cx - radius:cx + radius + 1]
        texture = float(candidate.std())
        quality["texture"] = _bounded(texture / 48)
        if texture < MIN_TEXTURE_STD:
            return result("lost", "The selected point lost visual detail; select it again.")
        state.template = previous.template
        return result("tracking", "Selected point is tracked in this image.", center)


def _context_id(value: str) -> str:
    try:
        parsed = UUID(value)
        if str(parsed) != value.lower():
            raise ValueError
        return str(parsed)
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Context must be a canonical UUID.") from None
