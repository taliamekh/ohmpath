from __future__ import annotations

import argparse
from dataclasses import dataclass
import hmac
import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol

from .camera import CameraFrame, PiCameraCapture


BOUNDARY = b"ohmpath-video-frame"
MAX_FRAME_BYTES = 5 * 1024 * 1024
MAX_FPS = 20.0
MAX_CLIENTS = 8
MAX_STALE_S = 2.0


class LatestCamera(Protocol):
    def take_latest_frame(self, *, timeout_s: float | None = None) -> CameraFrame | None: ...
    def stop(self) -> None: ...


@dataclass(frozen=True, slots=True)
class VideoLimits:
    max_fps: float = 15.0
    max_frame_bytes: int = 2 * 1024 * 1024
    max_clients: int = 3


class _VideoHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 16

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(3.0)
        return request, address

    def __init__(self, address, handler, *, camera: LatestCamera, token: str, limits: VideoLimits):
        self.camera = camera
        self.bearer_token = token
        self.limits = limits
        self.stopping = threading.Event()
        self._client_slots = threading.BoundedSemaphore(limits.max_clients)
        self.last_stream_error: str | None = None
        super().__init__(address, handler)

    def process_request(self, request, client_address) -> None:
        if not self._client_slots.acquire(blocking=False):
            try:
                # Drain one bounded header before closing. Closing with unread
                # request bytes can reset the socket and hide the 503 on Windows.
                request.settimeout(0.25)
                header = bytearray()
                while b"\r\n\r\n" not in header and len(header) < 8192:
                    chunk = request.recv(min(1024, 8192 - len(header)))
                    if not chunk:
                        break
                    header.extend(chunk)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._client_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._client_slots.release()

    def shutdown(self) -> None:
        self.stopping.set()
        super().shutdown()

    def server_close(self) -> None:
        self.stopping.set()
        try:
            self.camera.stop()
        finally:
            super().server_close()


def _valid_jpeg(data: object, max_bytes: int) -> bool:
    return isinstance(data, bytes) and 4 <= len(data) <= max_bytes and data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9")


def create_video_server(
    camera: LatestCamera,
    *,
    bearer_token: str,
    port: int = 8766,
    max_fps: float = 15.0,
    max_frame_bytes: int = 2 * 1024 * 1024,
    max_clients: int = 3,
) -> ThreadingHTTPServer:
    """Build (without starting or opening hardware) an authenticated loopback MJPEG server."""
    if not isinstance(bearer_token, str) or not 32 <= len(bearer_token) <= 256 or any(ord(ch) < 33 or ord(ch) > 126 for ch in bearer_token):
        raise ValueError("video API requires a printable per-launch bearer token (32 to 256 characters)")
    if not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("video service port must be from 0 through 65535")
    if not isinstance(max_fps, (int, float)) or not math.isfinite(max_fps) or not 1 <= max_fps <= MAX_FPS:
        raise ValueError("video frame rate must be between 1 and 20 FPS")
    if not isinstance(max_frame_bytes, int) or not 4 <= max_frame_bytes <= MAX_FRAME_BYTES:
        raise ValueError("maximum JPEG size must be from 4 bytes through 5 MB")
    if not isinstance(max_clients, int) or not 1 <= max_clients <= MAX_CLIENTS:
        raise ValueError("video client limit must be from 1 through 8")
    limits = VideoLimits(float(max_fps), max_frame_bytes, max_clients)

    class Handler(BaseHTTPRequestHandler):
        server_version = "OhmPathPiVideo/0.1"

        @property
        def video_server(self) -> _VideoHTTPServer:
            return self.server  # type: ignore[return-value]

        def _json(self, status: int, payload: dict[str, object]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            return hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {bearer_token}")

        def do_GET(self) -> None:
            if self.path not in {"/v1/health", "/v1/stream.mjpg"}:
                self._json(404, {"error": "not_found"})
                return
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == "/v1/health":
                self._json(200, {
                    "service": "ohmpath-pi-video",
                    "mode": "camera",
                    "bind": "127.0.0.1",
                    "stream_path": "/v1/stream.mjpg",
                    "max_fps": limits.max_fps,
                    "max_frame_bytes": limits.max_frame_bytes,
                    "max_clients": limits.max_clients,
                    "physical_control": "disabled",
                })
                return
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY.decode('ascii')}")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, private")
            self.send_header("Pragma", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            period = 1.0 / limits.max_fps
            last_sent: float | None = None
            try:
                while not self.video_server.stopping.is_set():
                    frame = self.video_server.camera.take_latest_frame(timeout_s=min(0.5, period))
                    if frame is None:
                        continue
                    now = time.monotonic()
                    if not math.isfinite(frame.captured_monotonic_s) or now - frame.captured_monotonic_s > MAX_STALE_S or frame.captured_monotonic_s > now:
                        continue
                    if not _valid_jpeg(frame.jpeg, limits.max_frame_bytes):
                        self.video_server.last_stream_error = "camera returned invalid or oversized JPEG"
                        break
                    if last_sent is not None:
                        remaining = period - (now - last_sent)
                        if remaining > 0 and self.video_server.stopping.wait(remaining):
                            break
                    part = (b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + str(len(frame.jpeg)).encode("ascii") + b"\r\n\r\n")
                    self.wfile.write(part)
                    self.wfile.write(frame.jpeg)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                    last_sent = time.monotonic()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                return

        def log_message(self, format: str, *args: object) -> None:
            # Never log request headers, query values, or bearer credentials.
            return

    return _VideoHTTPServer(("127.0.0.1", port), Handler, camera=camera,
                            token=bearer_token, limits=limits)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ohm Path opt-in Pi camera video service")
    parser.add_argument("--enable-camera", action="store_true", help="explicitly opt in to Picamera2 capture")
    parser.add_argument("--port", type=int, default=8766, help="loopback service port (default: 8766)")
    parser.add_argument("--max-fps", type=float, default=15.0, help="capture and stream ceiling (1 to 20 FPS)")
    parser.add_argument("--max-clients", type=int, default=3, help="maximum concurrent health/stream clients (1 to 8)")
    parser.add_argument("--calibration-revision", default="unknown", help="label attached to captured frames")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.enable_camera:
        parser.error("camera service is disabled by default; pass --enable-camera to open Picamera2")
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if not math.isfinite(args.max_fps) or not 1 <= args.max_fps <= MAX_FPS:
        parser.error("max-fps must be between 1 and 20")
    if not 1 <= args.max_clients <= MAX_CLIENTS:
        parser.error("max-clients must be between 1 and 8")
    token = os.environ.get("OHMPATH_PI_VIDEO_TOKEN", "")
    if not 32 <= len(token) <= 256 or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        parser.error("set a per-launch OHMPATH_PI_VIDEO_TOKEN of 32 to 256 printable characters")

    capture = PiCameraCapture(enabled=True, calibration_revision=args.calibration_revision)
    server: ThreadingHTTPServer | None = None
    try:
        capture.start_stream(max_fps=args.max_fps)
        server = create_video_server(capture, bearer_token=token, port=args.port,
                                     max_fps=args.max_fps, max_clients=args.max_clients)
        print(f"Ohm Path Pi video service listening on 127.0.0.1:{args.port}", flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
    finally:
        if server is not None:
            server.server_close()
        else:
            capture.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
