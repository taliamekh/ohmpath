"""Offline photo API and lifecycle checks. No model, camera, or audio calls."""

import base64
import json
import threading
import time
import zlib
from uuid import uuid4

from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


USER = "u" * 40
MODEL = "m" * 40


def png(width=2, height=2):
    def chunk(kind, data):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes((8, 6, 0, 0, 0))
    pixels = b"".join(b"\x00" + b"\x00\x00\x00\xff" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def request(context=None, images=None):
    context = context or str(uuid4())
    images = images or [(str(uuid4()), png())]
    return {"context_id": context, "question": "What can you see?", "images": [
        {"image_id": image_id, "mime_type": "image/png", "image_base64": base64.b64encode(raw).decode()}
        for image_id, raw in images]}


def answer(image_id):
    return {"explanation": "The visible traces may connect these parts; verify with a meter.",
            "observations": ["Two dark traces are visible."], "questions": ["Can you show the underside?"],
            "next_steps": ["Inspect the trace with power off."],
            "annotations": [{"image_id": image_id, "x": .5, "y": .3, "label": "Visible trace"}],
            "limitations": ["A photo cannot confirm continuity."]}


def poll(client, turn_id):
    for _ in range(200):
        result = client.get(f"/v1/photo-help/{turn_id}", headers={"Authorization": f"Bearer {USER}"})
        assert result.status_code == 200
        if result.json()["status"] != "running":
            return result.json()
        time.sleep(.01)
    raise AssertionError("photo turn did not finish")


def test_photo_api_is_user_only_and_rejects_invalid_images_before_model(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    calls = []
    app.state.photo_help.runner = lambda *args: calls.append(args)
    with TestClient(app) as client:
        good = request()
        denied = client.post("/v1/photo-help/investigate", json=good,
                             headers={"Authorization": f"Bearer {MODEL}"})
        assert denied.status_code == 403
        for broken in (b"plain text", png(4000, 4000), png()[:-4]):
            payload = request(images=[(str(uuid4()), broken)])
            rejected = client.post("/v1/photo-help/investigate", json=payload,
                                   headers={"Authorization": f"Bearer {USER}"})
            assert rejected.status_code == 422
        payload = request()
        payload["images"][0]["image_base64"] = "%%%"
        assert client.post("/v1/photo-help/investigate", json=payload,
                           headers={"Authorization": f"Bearer {USER}"}).status_code == 422
        assert calls == []
        assert not app.state.photo_help.jobs


def test_photo_context_followup_revision_and_ephemeral_files(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    observed = []

    def fake_runner(context_id, revision, question, images, history, cancel):
        observed.append((revision, list(history), [path for _, path in images],
                         [path.read_bytes() for _, path in images]))
        return answer(images[0][0])

    app.state.photo_help.runner = fake_runner
    context = str(uuid4())
    image_id = str(uuid4())
    first = request(context, [(image_id, png())])
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {USER}"}
        started = client.post("/v1/photo-help/investigate", json=first, headers=headers)
        assert started.status_code == 200
        finished = poll(client, started.json()["turn_id"])
        assert finished["status"] == "completed"
        assert finished["answer"]["annotations"][0]["image_id"] == image_id
        assert observed[0][1] == []
        assert observed[0][3] == [png()]
        assert all(not path.exists() for path in observed[0][2])

        follow = client.post("/v1/photo-help/investigate", json=first, headers=headers)
        assert poll(client, follow.json()["turn_id"])["status"] == "completed"
        assert len(observed[1][1]) == 1
        assert observed[1][0] == observed[0][0]

        changed = request(context, [(image_id, png(3, 2))])
        changed_turn = client.post("/v1/photo-help/investigate", json=changed, headers=headers)
        assert poll(client, changed_turn.json()["turn_id"])["status"] == "completed"
        assert observed[2][1] == []
        assert observed[2][0] != observed[0][0]
        stale = client.get(f"/v1/photo-help/{started.json()['turn_id']}", headers=headers).json()
        assert stale["status"] == "stale" and "answer" not in stale
        assert base64.b64encode(png()).decode() not in json.dumps(app.state.photo_help.contexts)


def test_photo_cancel_and_legacy_admission(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    entered = threading.Event()
    released = threading.Event()

    def waiting_runner(context_id, revision, question, images, history, cancel):
        entered.set()
        released.wait(timeout=2)
        return answer(images[0][0])

    app.state.photo_help.runner = waiting_runner
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {USER}"}
        payload = request()
        started = client.post("/v1/photo-help/investigate", json=payload, headers=headers)
        assert started.status_code == 200 and entered.wait(timeout=1)
        assert client.post("/v1/photo-help/investigate", json=request(), headers=headers).status_code == 429
        session = client.post("/v1/sessions", json={}, headers=headers).json()
        app.state.investigations.base_url = "http://127.0.0.1:1"
        assert client.post(f"/v1/sessions/{session['session_id']}/investigate",
                           json={"question": "Look"}, headers=headers).status_code == 429
        cancelled = client.post("/v1/photo-help/cancel", json={"context_id": payload["context_id"],
            "turn_id": started.json()["turn_id"]}, headers=headers)
        assert cancelled.json()["status"] == "cancelled"
        released.set()
        assert poll(client, started.json()["turn_id"])["status"] == "cancelled"


def test_bad_annotation_fails_closed_without_echoing_provider_message(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    app.state.photo_help.runner = lambda _, __, ___, images, ____, _____: {
        **answer(images[0][0]), "annotations": [{"image_id": str(uuid4()), "x": .5, "y": .5,
                                                  "label": "secret-provider-path"}]}
    with TestClient(app) as client:
        started = client.post("/v1/photo-help/investigate", json=request(),
                              headers={"Authorization": f"Bearer {USER}"})
        result = poll(client, started.json()["turn_id"])
        assert result["status"] == "failed" and "answer" not in result
        assert "secret-provider-path" not in json.dumps(result)


def test_cancel_context_before_late_start_blocks_model_turn(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    calls = []
    app.state.photo_help.runner = lambda *args: calls.append(args)
    payload = request()
    headers = {"Authorization": f"Bearer {USER}"}
    with TestClient(app) as client:
        cancelled = client.post("/v1/photo-help/cancel",
                                json={"context_id": payload["context_id"]}, headers=headers)
        assert cancelled.status_code == 200
        late = client.post("/v1/photo-help/investigate", json=payload, headers=headers)
        assert late.status_code == 409
        assert late.json()["error"] == "photo_context_cancelled"
        assert calls == []
        assert not app.state.photo_help.jobs


def test_model_capability_cannot_read_or_cancel_photo_turn(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    app.state.photo_help.runner = lambda _, __, ___, images, ____, _____: answer(images[0][0])
    payload = request()
    with TestClient(app) as client:
        started = client.post("/v1/photo-help/investigate", json=payload,
                              headers={"Authorization": f"Bearer {USER}"})
        turn_id = started.json()["turn_id"]
        model_headers = {"Authorization": f"Bearer {MODEL}"}
        assert client.get(f"/v1/photo-help/{turn_id}", headers=model_headers).status_code == 403
        assert client.post("/v1/photo-help/cancel", json={"context_id": payload["context_id"]},
                           headers=model_headers).status_code == 403


def test_photo_admission_rejects_active_legacy_investigation(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    entered = threading.Event()
    released = threading.Event()

    def legacy_runner(*args, **kwargs):
        entered.set()
        released.wait(timeout=2)
        return {"answer": "Local fake reply."}

    app.state.investigations.base_url = "http://127.0.0.1:1"
    app.state.investigations.runner = legacy_runner
    app.state.photo_help.runner = lambda _, __, ___, images, ____, _____: answer(images[0][0])
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {USER}"}
        session = client.post("/v1/sessions", json={}, headers=headers).json()
        started = client.post(f"/v1/sessions/{session['session_id']}/investigate",
                              json={"question": "Review the bench"}, headers=headers)
        assert started.status_code == 200 and entered.wait(timeout=1)
        rejected = client.post("/v1/photo-help/investigate", json=request(), headers=headers)
        assert rejected.status_code == 429
        assert not app.state.photo_help.jobs
        released.set()
