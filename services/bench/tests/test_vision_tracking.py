"""Software-only tracking checks; no camera, device, or provider is opened."""

from __future__ import annotations

import time
import zlib
from uuid import uuid4

import cv2
import numpy as np
import pytest

from ohmpath.vision.tracking import MAX_IMAGE_BYTES, VisualTracker


def image_bytes(array: np.ndarray, suffix: str = ".png") -> bytes:
    success, encoded = cv2.imencode(suffix, array)
    assert success
    return encoded.tobytes()


def board() -> np.ndarray:
    random = np.random.default_rng(1241)
    image = random.integers(25, 225, (240, 320), dtype=np.uint8)
    cv2.rectangle(image, (24, 24), (296, 216), 245, 2)
    cv2.circle(image, (160, 120), 9, 4, 2)
    cv2.line(image, (80, 180), (220, 50), 110, 3)
    return image


def moved(image: np.ndarray, dx: int, dy: int) -> np.ndarray:
    matrix = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(image, matrix, (image.shape[1], image.shape[0]),
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def call(tracker: VisualTracker, context: str, sequence: int, image: bytes,
         *, point: tuple[float, float] | None = None, source: str = "overview",
         now: float = 10.0) -> dict:
    return tracker.process(context_id=context, source=source, sequence=sequence,
                           image=image, point=point, now=now)


def test_selected_point_tracks_translated_textured_board_and_reports_bounded_quality() -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    original = board()
    first = call(tracker, context, 1, image_bytes(original), point=(160 / 319, 120 / 239))
    assert first["status"] == "tracking"
    assert first["target"] == {"x": round(160 / 319, 6), "y": round(120 / 239, 6)}
    assert set(first["quality"]) == {"brightness", "contrast", "sharpness", "texture", "match"}
    assert all(0 <= value <= 1 for value in first["quality"].values())
    assert "image" not in first

    second = call(tracker, context, 2, image_bytes(moved(original, 8, -6)), now=10.07)
    assert second["status"] == "tracking"
    assert abs(second["target"]["x"] - 168 / 319) <= 1 / 319
    assert abs(second["target"]["y"] - 114 / 239) <= 1 / 239
    assert second["quality"]["match"] >= 0.78
    third = call(tracker, context, 3, image_bytes(moved(original, 14, -9), ".jpg"), now=10.14)
    assert third["status"] == "tracking"
    assert abs(third["target"]["x"] - 174 / 319) <= 1 / 319
    assert abs(third["target"]["y"] - 111 / 239) <= 1 / 239


@pytest.mark.parametrize("replacement", [
    np.full((240, 320), 128, dtype=np.uint8),
    np.zeros((240, 320), dtype=np.uint8),
    np.random.default_rng(999).integers(0, 256, (240, 320), dtype=np.uint8),
])
def test_occlusion_blank_or_unrelated_scene_loses_target_without_reacquisition(replacement: np.ndarray) -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    call(tracker, context, 1, image_bytes(board()), point=(160 / 319, 120 / 239))
    lost = call(tracker, context, 2, image_bytes(replacement), now=10.1)
    assert lost["status"] == "lost" and lost["target"] is None
    again = call(tracker, context, 3, image_bytes(board()), now=10.2)
    assert again["status"] == "lost" and again["target"] is None


def test_large_jump_and_bad_initial_points_are_lost() -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    original = board()
    assert call(tracker, context, 1, image_bytes(original), point=(0.0, 0.0))["status"] == "lost"
    assert call(tracker, context, 2, image_bytes(np.full_like(original, 120)),
                point=(0.5, 0.5), now=10.1)["status"] == "lost"
    assert call(tracker, context, 3, image_bytes(original),
                point=(160 / 319, 120 / 239), now=10.2)["status"] == "tracking"
    assert call(tracker, context, 4, image_bytes(moved(original, 90, 0)), now=10.3)["status"] == "lost"


def test_repeated_visual_patch_is_ambiguous_and_lost() -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    image = np.full((240, 320), 100, dtype=np.uint8)
    patch = np.random.default_rng(81).integers(0, 256, (33, 33), dtype=np.uint8)
    image[104:137, 84:117] = patch
    image[104:137, 129:162] = patch
    encoded = image_bytes(image)
    assert call(tracker, context, 1, encoded, point=(100 / 319, 120 / 239))["status"] == "tracking"
    assert call(tracker, context, 2, encoded, now=10.1)["status"] == "lost"


def test_context_source_resolution_and_staleness_invalidate_old_target() -> None:
    image = board()
    encoded = image_bytes(image)
    tracker = VisualTracker()
    first_context = str(uuid4())
    second_context = str(uuid4())
    call(tracker, first_context, 1, encoded, point=(0.5, 0.5))
    assert call(tracker, second_context, 1, encoded)["status"] == "idle"
    assert call(tracker, first_context, 2, encoded, source="pi", now=10.1)["status"] == "lost"
    assert call(tracker, first_context, 3, encoded, source="pi", point=(0.5, 0.5),
                now=10.2)["status"] == "tracking"
    resized = image_bytes(cv2.resize(image, (300, 220)))
    assert call(tracker, first_context, 4, resized, source="pi", now=10.3)["status"] == "lost"
    assert call(tracker, first_context, 5, resized, source="pi", point=(0.5, 0.5),
                now=10.4)["status"] == "tracking"
    assert call(tracker, first_context, 6, resized, source="pi", now=12.5)["status"] == "lost"
    tracker.reset(first_context)
    assert call(tracker, first_context, 1, resized, source="pi", now=13)["status"] == "idle"


def test_rejects_out_of_order_invalid_context_and_excess_active_contexts() -> None:
    tracker = VisualTracker()
    encoded = image_bytes(board())
    contexts = [str(uuid4()) for _ in range(3)]
    call(tracker, contexts[0], 2, encoded, now=10)
    with pytest.raises(ValueError, match="backwards"):
        call(tracker, contexts[0], 2, encoded, now=10.1)
    with pytest.raises(ValueError, match="backwards"):
        call(tracker, contexts[0], 3, encoded, now=9.9)
    call(tracker, contexts[1], 1, encoded)
    with pytest.raises(ValueError, match="two visual contexts"):
        call(tracker, contexts[2], 1, encoded)
    tracker.reset(contexts[0])
    assert call(tracker, contexts[2], 1, encoded)["status"] == "idle"
    with pytest.raises(ValueError, match="canonical UUID"):
        call(tracker, "not-a-context", 1, encoded)
    with pytest.raises(ValueError, match="Source"):
        call(tracker, contexts[2], 2, encoded, source="webcam")
    with pytest.raises(ValueError, match="Sequence"):
        call(tracker, contexts[2], 0, encoded)
    with pytest.raises(ValueError, match="Point"):
        call(tracker, contexts[2], 2, encoded, point=(float("nan"), 0.5))


def test_rejects_oversized_incomplete_or_declared_huge_images_before_decode(monkeypatch: pytest.MonkeyPatch) -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    valid = image_bytes(board())
    called = False

    def forbidden_decode(*_args: object, **_kwargs: object) -> None:
        nonlocal called
        called = True
        raise AssertionError("decoder should not run")

    monkeypatch.setattr(cv2, "imdecode", forbidden_decode)
    invalid = [b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff\xd9", valid[:24],
               b"\xff\xd8" + b"x" * MAX_IMAGE_BYTES,
               valid + b"x" * MAX_IMAGE_BYTES]
    huge = bytearray(valid)
    huge[16:20] = (50_000).to_bytes(4, "big")
    huge[29:33] = zlib.crc32(huge[12:29]).to_bytes(4, "big")
    invalid.append(bytes(huge))
    for raw in invalid:
        with pytest.raises(ValueError):
            call(tracker, context, 1, raw)
    assert not called


def test_short_cpu_replay_records_observed_time_without_promising_frame_rate() -> None:
    tracker = VisualTracker()
    context = str(uuid4())
    original = np.full((960, 1280), 100, dtype=np.uint8)
    original[360:600, 480:800] = board()
    images = [image_bytes(moved(original, shift, 0), ".jpg") for shift in range(12)]
    assert all(len(encoded) <= MAX_IMAGE_BYTES for encoded in images)
    started = time.perf_counter()
    for index, encoded in enumerate(images, start=1):
        result = call(tracker, context, index, encoded,
                      point=(640 / 1279, 480 / 959) if index == 1 else None,
                      now=10 + index / 15)
        assert result["status"] == "tracking"
    elapsed = time.perf_counter() - started
    print(f"12 synthetic 1280x960 frames processed in {elapsed:.3f} seconds ({elapsed / 12 * 1000:.1f} ms/frame)")
