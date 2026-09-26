from __future__ import annotations

import base64
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import cv2
import numpy as np
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


USER = "u" * 40
MODEL = "m" * 40


def scene(shift: int = 0) -> str:
    random = np.random.default_rng(1241)
    image = random.integers(25, 225, (240, 320), dtype=np.uint8)
    matrix = np.float32([[1, 0, shift], [0, 1, 0]])
    image = cv2.warpAffine(image, matrix, (image.shape[1], image.shape[0]))
    success, encoded = cv2.imencode(".png", image)
    assert success
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def payload(context_id: str, sequence: int, image_base64: str, **overrides) -> dict:
    return {"context_id": context_id, "source": "overview", "sequence": sequence,
            "image_base64": image_base64, **overrides}


def test_user_can_track_and_reset_a_local_observation_without_session_evidence(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    context = str(uuid4())
    with TestClient(app, headers={"Authorization": "Bearer " + USER}) as client:
        before_sessions = app.state.store.list_sessions()
        first = client.post("/v1/vision/track", json=payload(
            context, 1, scene(), point={"x": 160 / 319, "y": 120 / 239}))
        assert first.status_code == 200
        result = first.json()
        assert result["status"] == "tracking"
        assert result["source"] == "overview" and result["sequence"] == 1
        assert result["local_only"] is True and result["observation_only"] is True
        assert result["target"] == {"x": round(160 / 319, 6), "y": round(120 / 239, 6)}
        assert "image" not in result and "image_base64" not in result

        second = client.post("/v1/vision/track", json=payload(context, 2, scene(8)))
        assert second.status_code == 200
        assert second.json()["status"] == "tracking"
        assert abs(second.json()["target"]["x"] - 168 / 319) <= 1 / 319

        reset = client.post("/v1/vision/reset", json={"context_id": context})
        assert reset.status_code == 200
        assert reset.json() == {"context_id": context, "reset": True,
                                "local_only": True, "observation_only": True}
        after_reset = client.post("/v1/vision/track", json=payload(context, 1, scene()))
        assert after_reset.status_code == 200 and after_reset.json()["status"] == "idle"
        assert app.state.store.list_sessions() == before_sessions == []


def test_tracking_and_reset_require_user_capability(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    context = str(uuid4())
    body = payload(context, 1, scene(), point={"x": 0.5, "y": 0.5})
    with TestClient(app) as client:
        assert client.post("/v1/vision/track", json=body).status_code == 401
        assert client.post("/v1/vision/reset", json={"context_id": context}).status_code == 401
        model = {"Authorization": "Bearer " + MODEL}
        track = client.post("/v1/vision/track", json=body, headers=model)
        reset = client.post("/v1/vision/reset", json={"context_id": context}, headers=model)
        assert track.status_code == reset.status_code == 403
        assert track.json()["error"] == reset.json()["error"] == "capability_denied"


def test_tracking_rejects_invalid_base64_oversize_images_and_bad_context_without_echo(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    context = str(uuid4())
    headers = {"Authorization": "Bearer " + USER}
    with TestClient(app, headers=headers) as client:
        malformed = client.post("/v1/vision/track", json=payload(context, 1, "abc$"))
        assert malformed.status_code == 422
        assert malformed.json() == {"error": "vision_input_invalid",
                                    "message": "The image or tracking request is invalid."}
        non_ascii = client.post("/v1/vision/track", json=payload(context, 1, "é"))
        assert non_ascii.status_code == 422 and "é" not in non_ascii.text

        too_long = client.post("/v1/vision/track", json=payload(context, 1, "A" * 700_001))
        assert too_long.status_code == 422 and "AAAA" not in too_long.text

        decoded_oversize = base64.b64encode(b"x" * (512 * 1024 + 1)).decode("ascii")
        oversized = client.post("/v1/vision/track", json=payload(context, 1, decoded_oversize))
        assert oversized.status_code == 422
        bad_context = client.post("/v1/vision/reset", json={"context_id": "z" * 36})
        assert bad_context.status_code == 422
        assert app.state.store.list_sessions() == []


def test_parallel_frame_is_rejected_while_tracker_is_processing(tmp_path, monkeypatch):
    app = create_app(tmp_path, USER, MODEL)
    context = str(uuid4())
    entered = threading.Event()
    release = threading.Event()
    original_process = app.state.vision_tracker.process

    def blocked_process(**kwargs):
        entered.set()
        assert release.wait(timeout=3)
        return original_process(**kwargs)

    monkeypatch.setattr(app.state.vision_tracker, "process", blocked_process)
    client = TestClient(app, headers={"Authorization": "Bearer " + USER})
    body = payload(context, 1, scene(), point={"x": 0.5, "y": 0.5})
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, "/v1/vision/track", json=body)
        assert entered.wait(timeout=3)
        busy = client.post("/v1/vision/reset", json={"context_id": context})
        assert busy.status_code == 409 and busy.json()["error"] == "vision_busy"
        release.set()
        assert pending.result(timeout=3).status_code == 200
    client.close()


def test_tracker_failure_returns_safe_error_without_exception_details(tmp_path, monkeypatch):
    app = create_app(tmp_path, USER, MODEL)
    monkeypatch.setattr(app.state.vision_tracker, "process",
                        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("private image bytes")))
    with TestClient(app, headers={"Authorization": "Bearer " + USER}) as client:
        response = client.post("/v1/vision/track", json=payload(str(uuid4()), 1, scene()))
    assert response.status_code == 500
    assert response.json() == {"error": "vision_failed",
                               "message": "Local visual tracking could not finish this frame."}
    assert "private image bytes" not in response.text
