import pytest

from ohmpath.vision import CameraFrame, CamoCameraSource, LatestFrameBuffer, PiCameraSource


def frame(sequence: int, captured: float, camera_id: str = "cam") -> CameraFrame:
    return CameraFrame(camera_id, sequence, captured, 640, 480, b"synthetic", source_label="mock")


def test_latest_frame_buffer_is_capacity_one_and_rejects_out_of_order_frames():
    buffer = LatestFrameBuffer("cam")
    assert buffer.publish(frame(2, 10.0), now_monotonic=10.1)
    assert buffer.publish(frame(4, 10.2), now_monotonic=10.2)
    assert not buffer.publish(frame(3, 10.15), now_monotonic=10.2)
    assert buffer.latest(now_monotonic=10.25, max_age_seconds=1).source_sequence == 4


def test_stale_future_and_disconnected_frames_are_unavailable():
    buffer = LatestFrameBuffer("cam")
    assert not buffer.publish(frame(1, 5.1), now_monotonic=5.0)
    assert buffer.publish(frame(2, 4.0), now_monotonic=5.0)
    assert buffer.latest(now_monotonic=5.1, max_age_seconds=1) is None
    buffer.reconnect()
    assert buffer.publish(frame(1, 6.0), now_monotonic=6.0)
    buffer.disconnect()
    assert buffer.latest(now_monotonic=6, max_age_seconds=1) is None


def test_named_sources_are_explicitly_disconnected_without_opening_devices():
    assert "disconnected" in CamoCameraSource().source_label
    assert "disconnected" in PiCameraSource().source_label


def test_invalid_clock_cannot_make_old_frame_fresh():
    buffer = LatestFrameBuffer("cam")
    with pytest.raises(ValueError):
        frame(1, float("nan"))
    assert not buffer.publish(frame(1, 1), now_monotonic=float("nan"))
    buffer.publish(frame(1, 1), now_monotonic=1)
    with pytest.raises(ValueError):
        buffer.latest(now_monotonic=2, max_age_seconds=float("inf"))
    source = CamoCameraSource("cam")
    assert not source.frames.publish(frame(1, 1), now_monotonic=1)
