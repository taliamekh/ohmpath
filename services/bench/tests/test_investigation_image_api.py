import base64
import json
import time

from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


USER_TOKEN = "u" * 40
MODEL_TOKEN = "m" * 40


def png_header(width=1, height=1):
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
            + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00\x00\x00\x00\x00")


def session_id(client):
    response = client.post("/v1/sessions", headers={"Authorization": f"Bearer {USER_TOKEN}"}, json={})
    assert response.status_code == 200
    return response.json()["session_id"]


def wait_for_turn(client, sid, turn_id):
    headers = {"Authorization": f"Bearer {USER_TOKEN}"}
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = client.get(f"/v1/sessions/{sid}/investigate/{turn_id}", headers=headers)
        assert response.status_code == 200
        result = response.json()
        if result["status"] != "running":
            return result
        time.sleep(.005)
    raise AssertionError("Image investigation did not finish")


def test_image_route_is_user_only_and_rejects_invalid_inputs_before_turn(tmp_path):
    app = create_app(tmp_path, USER_TOKEN, MODEL_TOKEN)
    with TestClient(app) as client:
        sid = session_id(client)
        path = f"/v1/sessions/{sid}/investigate/image"
        model_headers = {"Authorization": f"Bearer {MODEL_TOKEN}"}
        user_headers = {"Authorization": f"Bearer {USER_TOKEN}"}

        denied = client.post(path, headers=model_headers,
                             json={"question": "Review this", "image_base64": base64.b64encode(png_header()).decode()})
        assert denied.status_code == 403

        for encoded in ("%%%not-base64%%%", base64.b64encode(b"plain text, not an image").decode(),
                        base64.b64encode(png_header() + b"x" * 2_000_000).decode()):
            rejected = client.post(path, headers=user_headers,
                                   json={"question": "Review this", "image_base64": encoded})
            assert rejected.status_code == 422
        assert not app.state.investigations.jobs
        assert not any(event["event_type"] == "investigation.started"
                       for event in app.state.store.events(sid))


def test_valid_image_route_passes_private_temp_path_and_records_only_metadata(tmp_path):
    image = png_header(5, 7)
    observed = {}

    def fake_runner(*args, image_path, cancel_event):
        observed["path"] = image_path
        observed["exists"] = image_path.is_file()
        observed["bytes"] = image_path.read_bytes()
        observed["suffix"] = image_path.suffix
        return {"answer": "User image reviewed as context only."}

    app = create_app(tmp_path, USER_TOKEN, MODEL_TOKEN)
    app.state.investigations.base_url = "http://127.0.0.1:12345"
    app.state.investigations.runner = fake_runner
    with TestClient(app) as client:
        sid = session_id(client)
        response = client.post(
            f"/v1/sessions/{sid}/investigate/image",
            headers={"Authorization": f"Bearer {USER_TOKEN}"},
            json={"question": "Describe the reviewed image", "image_base64": base64.b64encode(image).decode("ascii")},
        )
        assert response.status_code == 200
        turn_id = response.json()["turn_id"]
        assert wait_for_turn(client, sid, turn_id)["status"] == "completed"
        assert observed["exists"] is True
        assert observed["bytes"] == image
        assert observed["suffix"] == ".png"
        assert not observed["path"].exists()

        events = app.state.store.events(sid)
        started = next(event for event in events if event["event_type"] == "investigation.started")
        assert started["payload"]["image_attached"] is True
        assert started["payload"]["image_sha256"]
        encoded_image = base64.b64encode(image).decode("ascii")
        serialized = json.dumps(events)
        assert encoded_image not in serialized
        assert image.decode("latin1") not in serialized
        assert str(observed["path"]) not in serialized
