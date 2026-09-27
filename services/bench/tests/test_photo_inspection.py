"""Frozen-photo crop checks; no camera, recognition, or subscription usage."""

import base64
import json

import cv2
import numpy as np
import pytest

from ohmpath.vision.photo_inspection import PhotoInspector


def photo(tmp_path, pixels):
    ok, encoded = cv2.imencode(".png", pixels)
    assert ok
    path = tmp_path / "current.png"
    path.write_bytes(encoded.tobytes())
    return PhotoInspector([("current", path)])


def region(**changes):
    return {"image_id": "current", "region": {"x": .25, "y": .25, "width": .5, "height": .5} | changes}


def test_crop_preserves_original_pixels_and_coordinate_mapping(tmp_path):
    pixels = np.zeros((100, 200, 3), dtype=np.uint8)
    pixels[25:75, 50:150] = (17, 53, 193)
    result = photo(tmp_path, pixels).inspect(region())
    assert result["success"]
    metadata = json.loads(result["contentItems"][0]["text"])
    assert metadata["source_region"] == region()["region"]
    assert metadata["source_pixels"] == {"width": 100, "height": 50}
    raw = base64.b64decode(result["contentItems"][1]["imageUrl"].split(",", 1)[1])
    actual = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    np.testing.assert_array_equal(actual, pixels[25:75, 50:150])
    assert "unknown values" in metadata["interpretation"]


@pytest.mark.parametrize("changes", [{"width": 0}, {"x": .8}, {"height": float("nan")},
                                    {"width": True}, {"y": -.1}, {"x": "0"}])
def test_invalid_model_regions_are_rejected(tmp_path, changes):
    assert not photo(tmp_path, np.zeros((100, 100, 3), np.uint8)).inspect(region(**changes))["success"]


def test_cannot_read_an_unregistered_image_or_path(tmp_path):
    inspector = photo(tmp_path, np.zeros((100, 100, 3), np.uint8))
    request = region()
    request["image_id"] = str(tmp_path / "secret.png")
    assert not inspector.inspect(request)["success"]
    assert not inspector.inspect(region() | {"path": "secret.png"})["success"]


def test_dark_blank_region_has_actionable_quality_hints_and_two_call_limit(tmp_path):
    inspector = photo(tmp_path, np.zeros((100, 100, 3), np.uint8))
    result = inspector.inspect(region())
    metadata = json.loads(result["contentItems"][0]["text"])
    assert any("dark" in hint for hint in metadata["quality_hints"])
    assert any("blank surface" in hint for hint in metadata["quality_hints"])
    assert inspector.inspect(region())["success"]
    assert not inspector.inspect(region())["success"]


def test_response_is_bounded_without_upsampling(tmp_path):
    pixels = np.random.default_rng(32).integers(0, 256, (900, 900, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    path = tmp_path / "current.jpg"
    path.write_bytes(encoded.tobytes())
    result = PhotoInspector([("current", path)]).inspect(region(x=0, y=0, width=1, height=1))
    assert result["success"]
    assert len(json.dumps(result).encode()) < 256_000
    metadata = json.loads(result["contentItems"][0]["text"])
    assert metadata["delivered_pixels"]["width"] <= 640
    assert metadata["resized_down"]


def test_tiny_native_region_requires_a_new_view(tmp_path):
    inspector = photo(tmp_path, np.zeros((100, 100, 3), np.uint8))
    result = inspector.inspect(region(width=.01))
    assert not result["success"]
    assert "closer physical photo" in result["contentItems"][0]["text"]
