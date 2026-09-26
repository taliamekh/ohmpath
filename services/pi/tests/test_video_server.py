from __future__ import annotations

from collections import deque
from http.client import HTTPConnection
import threading
import time

import pytest

from ohmpath_pi.camera import CameraFrame
import ohmpath_pi.video_server as video


TOKEN = "test-video-token-" + "x" * 32
JPEG = b"\xff\xd8synthetic-frame\xff\xd9"


class FakeCamera:
    def __init__(self):
        self.frames = deque()
        self.condition = threading.Condition()
        self.stopped = False

    def publish(self, data: bytes = JPEG):
        with self.condition:
            self.frames.clear()
            self.frames.append(CameraFrame("fake-1", time.monotonic(), data, "test-cal"))
            self.condition.notify_all()

    def take_latest_frame(self, *, timeout_s=None):
        with self.condition:
            if not self.frames and not self.stopped:
                self.condition.wait(timeout_s)
            return self.frames.pop() if self.frames else None

    def stop(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()


def running_server(camera, **kwargs):
    server = video.create_video_server(camera, bearer_token=TOKEN, port=0, **kwargs)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, server.server_address[1]


def close_server(server, thread):
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_service_binds_loopback_authenticates_health_and_never_exposes_token():
    camera = FakeCamera()
    server, thread, port = running_server(camera)
    try:
        unauth = HTTPConnection("127.0.0.1", port, timeout=2)
        unauth.request("GET", "/v1/health")
        denied = unauth.getresponse()
        assert denied.status == 401
        denied.read()
        unauth.close()

        conn = HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
        response = conn.getresponse()
        assert response.status == 200
        body = response.read().decode()
        assert '"mode":"camera"' in body
        assert '"physical_control":"disabled"' in body
        assert TOKEN not in body
        conn.close()
        assert server.server_address[0] == "127.0.0.1"
    finally:
        close_server(server, thread)
    assert camera.stopped


def test_authenticated_mjpeg_stream_sends_latest_bounded_jpeg():
    camera = FakeCamera()
    camera.publish()
    server, thread, port = running_server(camera, max_fps=5)
    conn = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        conn.request("GET", "/v1/stream.mjpg", headers={"Authorization": f"Bearer {TOKEN}"})
        response = conn.getresponse()
        assert response.status == 200
        assert response.getheader("Content-Type") == "multipart/x-mixed-replace; boundary=ohmpath-video-frame"
        received = bytearray()
        while JPEG not in received and len(received) < 2048:
            received.extend(response.read(1))
        assert JPEG in received
        assert b"Content-Length: " + str(len(JPEG)).encode() in received
    finally:
        conn.close()
        close_server(server, thread)


def test_video_client_limit_and_oversized_frame_are_bounded():
    camera = FakeCamera()
    server, thread, port = running_server(camera, max_clients=1, max_frame_bytes=32)
    first = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        first.request("GET", "/v1/stream.mjpg", headers={"Authorization": f"Bearer {TOKEN}"})
        stream_response = first.getresponse()
        assert stream_response.status == 200

        second = HTTPConnection("127.0.0.1", port, timeout=2)
        second.request("GET", "/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
        rejected = second.getresponse()
        assert rejected.status == 503
        rejected.read()
        second.close()

        camera.publish(b"\xff\xd8" + b"x" * 64 + b"\xff\xd9")
        assert stream_response.read() == b""
        assert server.last_stream_error == "camera returned invalid or oversized JPEG"
    finally:
        first.close()
        close_server(server, thread)


def test_client_disconnect_releases_stream_slot_when_next_frame_arrives():
    camera = FakeCamera()
    server, thread, port = running_server(camera, max_clients=1)
    stream = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        stream.request("GET", "/v1/stream.mjpg", headers={"Authorization": f"Bearer {TOKEN}"})
        assert stream.getresponse().status == 200
        stream.close()
        camera.publish()

        status = None
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            check = HTTPConnection("127.0.0.1", port, timeout=1)
            check.request("GET", "/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
            response = check.getresponse()
            status = response.status
            response.read()
            check.close()
            if status == 200:
                break
            time.sleep(0.05)
        assert status == 200
    finally:
        stream.close()
        close_server(server, thread)


def test_server_rejects_bad_limits_and_tokens():
    camera = FakeCamera()
    for kwargs in (
        {"bearer_token": "short"},
        {"bearer_token": TOKEN, "max_fps": 21},
        {"bearer_token": TOKEN, "max_frame_bytes": video.MAX_FRAME_BYTES + 1},
        {"bearer_token": TOKEN, "max_clients": video.MAX_CLIENTS + 1},
    ):
        with pytest.raises(ValueError):
            video.create_video_server(camera, **kwargs)


def test_cli_is_inert_without_flag_and_requires_scoped_token(monkeypatch):
    monkeypatch.delenv("OHMPATH_PI_VIDEO_TOKEN", raising=False)
    with pytest.raises(SystemExit) as disabled:
        video.main([])
    assert disabled.value.code == 2
    with pytest.raises(SystemExit) as no_token:
        video.main(["--enable-camera"])
    assert no_token.value.code == 2


def test_explicit_cli_start_uses_camera_capture_and_stops_it(monkeypatch, capsys):
    events = []

    class Capture:
        def __init__(self, *, enabled, calibration_revision):
            assert enabled is True
            events.append(("construct", calibration_revision))

        def start_stream(self, *, max_fps):
            events.append(("start", max_fps))

        def stop(self):
            events.append(("stop",))

    class Server:
        def __init__(self, camera):
            self.camera = camera

        def serve_forever(self, *, poll_interval):
            raise KeyboardInterrupt

        def server_close(self):
            events.append(("close",))
            self.camera.stop()

    monkeypatch.setattr(video, "PiCameraCapture", Capture)
    monkeypatch.setattr(video, "create_video_server", lambda camera, **kw: Server(camera))
    monkeypatch.setenv("OHMPATH_PI_VIDEO_TOKEN", TOKEN)
    assert video.main(["--enable-camera", "--port", "8766", "--max-fps", "8"]) == 0
    assert events == [("construct", "unknown"), ("start", 8.0), ("close",), ("stop",)]
    assert "127.0.0.1:8766" in capsys.readouterr().out
