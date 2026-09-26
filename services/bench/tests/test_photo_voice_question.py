"""Offline API checks for spoken Photo help question drafts."""

import base64

import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.voice.transcription import WhisperWorker


USER_TOKEN = "u" * 40
MODEL_TOKEN = "m" * 40
ROUTE = "/v1/voice/transcribe-question"
USER_HEADERS = {"Authorization": f"Bearer {USER_TOKEN}"}
MODEL_HEADERS = {"Authorization": f"Bearer {MODEL_TOKEN}"}
AUDIO = b"offline test audio; the worker is mocked"


def test_transcription_is_only_a_draft_and_cannot_confirm_measurement(tmp_path, monkeypatch):
    calls = []

    def fake_transcribe(self, wav_data):
        calls.append(wav_data)
        return {"text": "The meter reads twelve volts", "status": "final", "model": "fake"}

    monkeypatch.setattr(WhisperWorker, "transcribe", fake_transcribe)
    app = create_app(tmp_path, USER_TOKEN, MODEL_TOKEN)
    with TestClient(app) as client:
        created = client.post("/v1/sessions", headers=USER_HEADERS, json={})
        assert created.status_code == 200
        sid = created.json()["session_id"]
        root = f"/v1/sessions/{sid}"
        setup = client.post(root + "/setup", headers=USER_HEADERS,
                            json={"power_state": "on_current_limited", "setup": {"low_voltage_confirmed": True}})
        assert setup.status_code == 200
        requested = client.post(root + "/requests", headers=USER_HEADERS,
                                json={"quantity": "voltage", "meter_mode": "DC_voltage",
                                      "red_node_id": "B", "black_node_id": "GND"})
        assert requested.status_code == 200
        before_state = client.get(root, headers=USER_HEADERS).json()
        before_events = app.state.store.events(sid)

        response = client.post(ROUTE, headers=USER_HEADERS,
                               json={"wav_base64": base64.b64encode(AUDIO).decode("ascii")})

        assert response.status_code == 200
        assert response.json() == {"text": "The meter reads twelve volts", "status": "final", "local_only": True}
        assert calls == [AUDIO]
        assert client.get(root, headers=USER_HEADERS).json() == before_state
        assert app.state.store.events(sid) == before_events
        assert before_state["pending_candidate"] is None
        assert before_state["active_request"]["request_id"] == requested.json()["request_id"]


@pytest.mark.parametrize("body", [
    {"wav_base64": "%%%not base64%%%"},
    {"wav_base64": "éééé"},
    {"wav_base64": base64.b64encode(AUDIO).decode("ascii"), "request_id": "some-request"},
])
def test_invalid_question_input_never_reaches_speech_worker(tmp_path, monkeypatch, body):
    calls = []
    monkeypatch.setattr(WhisperWorker, "transcribe", lambda self, data: calls.append(data))
    with TestClient(create_app(tmp_path, USER_TOKEN, MODEL_TOKEN)) as client:
        response = client.post(ROUTE, headers=USER_HEADERS, json=body)
        assert response.status_code == 422
        assert calls == []


def test_question_transcription_requires_user_capability(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(WhisperWorker, "transcribe", lambda self, data: calls.append(data))
    body = {"wav_base64": base64.b64encode(AUDIO).decode("ascii")}
    with TestClient(create_app(tmp_path, USER_TOKEN, MODEL_TOKEN)) as client:
        assert client.post(ROUTE, json=body).status_code == 401
        denied = client.post(ROUTE, headers=MODEL_HEADERS, json=body)
        assert denied.status_code == 403
        assert denied.json()["error"] == "capability_denied"
        assert calls == []
