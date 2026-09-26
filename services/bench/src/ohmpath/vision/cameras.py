"""Bounded, volatile camera-frame interfaces. Opening hardware is explicit."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from importlib.util import find_spec
from math import isfinite
from threading import Lock
from typing import Protocol


class CameraStatus(StrEnum):
    DISCONNECTED = "disconnected"
    MOCK = "mock"
    CONNECTED = "connected"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class CameraFrame:
    camera_id: str
    source_sequence: int
    captured_monotonic: float
    width: int
    height: int
    image: bytes
    orientation_degrees: int = 0
    source_label: str = "unknown"
    calibration_revision: str | None = None

    def __post_init__(self) -> None:
        if not self.camera_id or self.source_sequence < 0 or not isfinite(self.captured_monotonic):
            raise ValueError("frame identity, sequence and finite capture time are required")
        if self.width <= 0 or self.height <= 0 or self.orientation_degrees not in (0, 90, 180, 270):
            raise ValueError("invalid frame dimensions or orientation")
        if not isinstance(self.image, bytes) or len(self.image) > 32 * 1024 * 1024:
            raise ValueError("frame image must be bounded bytes")


class CameraSource(Protocol):
    """Common source API; frame bytes remain in memory and are never persisted here."""

    camera_id: str
    source_label: str

    @property
    def status(self) -> CameraStatus: ...

    def disconnect(self) -> None: ...


class LatestFrameBuffer:
    """Capacity-one buffer that rejects stale and out-of-order camera frames."""

    capacity = 1

    def __init__(self, camera_id: str) -> None:
        if not camera_id:
            raise ValueError("camera_id is required")
        self.camera_id = camera_id
        self._frame: CameraFrame | None = None
        self._last_sequence = -1
        self._connected = True
        self._lock = Lock()

    def publish(self, frame: CameraFrame, *, now_monotonic: float) -> bool:
        """Keep only the newest fresh frame. Returns False for rejected frames."""
        if not isfinite(now_monotonic):
            return False
        with self._lock:
            if not self._connected or frame.camera_id != self.camera_id:
                return False
            if frame.source_sequence <= self._last_sequence:
                return False
            if frame.width <= 0 or frame.height <= 0 or frame.captured_monotonic > now_monotonic:
                return False
            self._last_sequence = frame.source_sequence
            self._frame = frame
            return True

    def latest(self, *, now_monotonic: float, max_age_seconds: float) -> CameraFrame | None:
        if not isfinite(now_monotonic) or not isfinite(max_age_seconds) or max_age_seconds < 0:
            raise ValueError("frame clock and maximum age must be finite and valid")
        with self._lock:
            frame = self._frame
            if not self._connected or frame is None:
                return None
            age = now_monotonic - frame.captured_monotonic
            if age < 0 or age > max_age_seconds:
                self._frame = None
                return None
            return frame

    def disconnect(self) -> None:
        with self._lock:
            self._connected = False
            self._frame = None

    def reconnect(self) -> None:
        """Start a new source epoch; sequence ordering restarts only after reconnect."""
        with self._lock:
            self._connected = True
            self._frame = None
            self._last_sequence = -1


class _AdapterState:
    def __init__(self, camera_id: str, source_label: str) -> None:
        self.camera_id = camera_id
        self.source_label = source_label
        self._status = CameraStatus.DISCONNECTED
        self.frames = LatestFrameBuffer(camera_id)
        self.frames.disconnect()

    @property
    def status(self) -> CameraStatus:
        return self._status

    def disconnect(self) -> None:
        self._status = CameraStatus.DISCONNECTED
        self.frames.disconnect()


class CamoCameraSource(_AdapterState):
    """iPhone/Camo source shell. It stays disconnected until an adapter is supplied."""

    def __init__(self, camera_id: str = "iphone-camo") -> None:
        super().__init__(camera_id, "iPhone via Camo USB (disconnected)")


class PiCameraSource(_AdapterState):
    """Pi camera-over-Ethernet source shell; no network connection is made here."""

    def __init__(self, camera_id: str = "pi-camera") -> None:
        super().__init__(camera_id, "Raspberry Pi camera via Ethernet (disconnected)")


class MockCameraSource(_AdapterState):
    """Explicit synthetic/replay source for tests. Never masquerades as a live camera."""

    def __init__(self, camera_id: str = "mock-camera") -> None:
        super().__init__(camera_id, "synthetic/replay (mock)")
        self._status = CameraStatus.MOCK
        self.frames.reconnect()

    def submit(self, frame: CameraFrame, *, now_monotonic: float) -> bool:
        if frame.source_label != "synthetic/replay (mock)":
            frame = CameraFrame(
                camera_id=frame.camera_id,
                source_sequence=frame.source_sequence,
                captured_monotonic=frame.captured_monotonic,
                width=frame.width,
                height=frame.height,
                image=frame.image,
                orientation_degrees=frame.orientation_degrees,
                source_label="synthetic/replay (mock)",
                calibration_revision=frame.calibration_revision,
            )
        return self.frames.publish(frame, now_monotonic=now_monotonic)


class OpenCVCameraProbe:
    """Opt-in OpenCV availability check. Calling it never requests a camera feed."""

    def __init__(self, camera_id: str, device_index: int) -> None:
        self.camera_id = camera_id
        self.device_index = device_index
        self.source_label = f"OpenCV device {device_index} (not opened)"
        self.status = CameraStatus.DISCONNECTED

    def availability(self) -> CameraStatus:
        if find_spec("cv2") is None:
            self.status = CameraStatus.UNAVAILABLE
        return self.status
