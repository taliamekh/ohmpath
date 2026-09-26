from __future__ import annotations

from dataclasses import dataclass
import io
import math
import threading
import time
from typing import Any, Callable, Protocol


class FrameSource(Protocol):
    def start(self) -> None: ...
    def capture_jpeg(self) -> bytes: ...
    def stop(self) -> None: ...


def _picamera2_factory() -> FrameSource:
    # Import and open the camera only after explicit opt-in calls start().
    from picamera2 import Picamera2  # type: ignore[import-not-found]

    camera = Picamera2()
    camera.configure(camera.create_video_configuration(main={"size": (1280, 720), "format": "RGB888"}))
    return _Picamera2Source(camera)


class _Picamera2Source:
    def __init__(self, camera: Any) -> None:
        self.camera = camera
        self.started = False

    def start(self) -> None:
        self.camera.start()
        self.started = True

    def capture_jpeg(self) -> bytes:
        if not self.started:
            raise RuntimeError("camera is not started")
        buffer = io.BytesIO()
        self.camera.capture_file(buffer, format="jpeg")
        return buffer.getvalue()

    def stop(self) -> None:
        if self.started:
            self.camera.stop()
            self.camera.close()
            self.started = False


@dataclass(frozen=True, slots=True)
class CameraFrame:
    frame_id: str
    captured_monotonic_s: float
    jpeg: bytes
    calibration_revision: str


class LatestFrameBuffer:
    """Single-slot replace-on-publish buffer; stale frames never queue behind new ones."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._frame: CameraFrame | None = None
        self._closed = False

    def publish(self, frame: CameraFrame) -> None:
        with self._condition:
            if self._closed:
                return
            self._frame = frame
            self._condition.notify_all()

    def take_latest(self, timeout_s: float | None = None) -> CameraFrame | None:
        with self._condition:
            if self._frame is None and not self._closed:
                self._condition.wait(timeout_s)
            frame, self._frame = self._frame, None
            return frame

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._frame = None
            self._condition.notify_all()


class PiCameraCapture:
    """Opt-in Picamera2 capture wrapper; import/construct performs no camera I/O."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        calibration_revision: str = "unknown",
        source_factory: Callable[[], FrameSource] | None = None,
    ) -> None:
        self.enabled = enabled
        self.calibration_revision = calibration_revision
        self._source_factory = source_factory or _picamera2_factory
        self._source: FrameSource | None = None
        self._next_id = 0
        self._lock = threading.Lock()
        self._stream_stop = threading.Event()
        self._stream_thread: threading.Thread | None = None
        self._latest_frames: LatestFrameBuffer | None = None

    def start(self) -> None:
        if not self.enabled:
            raise RuntimeError("Pi camera access is disabled; opt in explicitly before start")
        if self._source is not None:
            return
        source = self._source_factory()
        source.start()
        self._source = source

    def capture_latest(self, *, now_monotonic_s: float) -> CameraFrame:
        if self._source is None:
            raise RuntimeError("Pi camera is not started")
        with self._lock:
            jpeg = self._source.capture_jpeg()
            if not jpeg.startswith(b"\xff\xd8"):
                raise ValueError("camera source did not return a JPEG frame")
            self._next_id += 1
            return CameraFrame(f"pi-{self._next_id}", now_monotonic_s, jpeg, self.calibration_revision)

    def start_stream(self, *, max_fps: float = 15.0) -> None:
        if not math.isfinite(max_fps) or not 1.0 <= max_fps <= 20.0:
            raise ValueError("camera frame rate must be between 1 and 20 FPS")
        if self._stream_thread is not None:
            return
        self.start()
        self._latest_frames = LatestFrameBuffer()
        self._stream_stop.clear()

        def produce() -> None:
            period = 1.0 / max_fps
            while not self._stream_stop.is_set():
                started = time.monotonic()
                try:
                    frame = self.capture_latest(now_monotonic_s=started)
                    assert self._latest_frames is not None
                    self._latest_frames.publish(frame)
                except Exception:
                    self._stream_stop.set()
                    break
                self._stream_stop.wait(max(0.0, period - (time.monotonic() - started)))

        self._stream_thread = threading.Thread(target=produce, name="ohmpath-pi-camera", daemon=True)
        self._stream_thread.start()

    def take_latest_frame(self, *, timeout_s: float | None = None) -> CameraFrame | None:
        if self._latest_frames is None:
            raise RuntimeError("Pi camera stream is not started")
        return self._latest_frames.take_latest(timeout_s)

    def stop(self) -> None:
        self._stream_stop.set()
        if self._stream_thread is not None:
            self._stream_thread.join(timeout=1.0)
            self._stream_thread = None
        if self._latest_frames is not None:
            self._latest_frames.close()
            self._latest_frames = None
        if self._source is not None:
            self._source.stop()
            self._source = None
