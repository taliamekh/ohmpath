import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


@pytest.fixture
def bench(tmp_path):
    with TestClient(create_app(tmp_path, "user-token" * 5, "model-token" * 5)) as client:
        client.headers["Authorization"] = "Bearer " + "user-token" * 5
        sid = client.post("/v1/sessions", json={}).json()["session_id"]
        root = f"/v1/sessions/{sid}"
        client.post(root + "/setup", json={"power_state": "on_current_limited", "setup": {"low_voltage_confirmed": True}})
        req = client.post(root + "/requests", json={"quantity": "voltage", "meter_mode": "DC_voltage",
                            "red_node_id": "B", "black_node_id": "GND"}).json()
        yield client, root, req


def test_spoken_reading_and_bound_confirmation(bench):
    client, root, req = bench
    result = client.post(root + "/voice/text", json={"text": "minus twelve point five millivolts",
        "utterance_id": "u1", "request_id": req["request_id"]}).json()
    assert result["route"] == "reading"
    assert result["result"]["candidate"]["value"] == "-0.0125"
    conf = result["result"]["confirmation"]
    assert client.post(root + "/voice/text", json={"text": "yes", "utterance_id": "u2"}).status_code == 409
    client.post(root + "/readback", json={"confirmation_id": conf["confirmation_id"]})
    accepted = client.post(root + "/voice/text", json={"text": "yes", "utterance_id": "u3",
        "request_id": req["request_id"], "confirmation_id": conf["confirmation_id"]})
    assert accepted.status_code == 200
    event = accepted.json()["result"]
    assert event["payload"]["candidate"]["source"] == "voice"
    assert event["payload"]["evidence_kind"] == "simulated_user_input"


@pytest.mark.parametrize("fields", [{"final": False}, {"own_speech": True}, {"text": ""}])
def test_partial_echo_silence_never_capture_candidate(bench, fields):
    client, root, req = bench
    result = client.post(root + "/voice/text", json={"text": "two volts", "utterance_id": "u1",
        "request_id": req["request_id"], **fields})
    assert result.json()["route"] == "silence"
    assert client.get(root).json()["pending_candidate"] is None


def test_stale_yes_after_setup_change_is_rejected(bench):
    client, root, req = bench
    result = client.post(root + "/voice/text", json={"text": "one volt", "utterance_id": "u1",
        "request_id": req["request_id"]}).json()
    conf = result["result"]["confirmation"]
    client.post(root + "/readback", json={"confirmation_id": conf["confirmation_id"]})
    client.post(root + "/setup", json={"power_state": "unknown", "setup": {}})
    response = client.post(root + "/voice/text", json={"text": "yes", "utterance_id": "u2",
        "request_id": req["request_id"], "confirmation_id": conf["confirmation_id"]})
    assert response.status_code == 409


def test_question_does_not_consume_pending_measurement(bench):
    client, root, req = bench
    result = client.post(root + "/voice/text", json={"text": "Why are we testing 2 volts?",
        "utterance_id": "question"}).json()
    assert result["route"] == "question"
    assert result["result"]["source"] == "local_evidence_summary"
    assert client.get(root).json()["active_request"]["request_id"] == req["request_id"]
