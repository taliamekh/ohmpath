from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


def test_report_excludes_private_logs_and_separates_practice_evidence(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        sid = client.post("/v1/sessions", json={"name": "Report test"}).json()["session_id"]
        root = f"/v1/sessions/{sid}"
        client.post(root + "/firmware/analyze", json={"log_text": "Private serial message do not export"})
        report = client.get(root + "/report").json()["markdown"]
        assert "Private serial message" not in report
        assert "practice (simulated user inputs)" in report
        assert "Physical verification: pending" in report
        assert "No confirmed readings" in report
        assert client.get(root + "/report", headers={"Authorization": "Bearer " + "m" * 40}).status_code == 403


def test_manual_mode_never_claims_instrument_verification(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={"name": "Manual session", "mode": "supervised"}).json()
        root = f"/v1/sessions/{state['session_id']}"
        assert state["hardware_state"] == "disarmed"
        client.post(root + "/setup", json={"power_state": "on_current_limited", "setup": {"low_voltage_confirmed": True}})
        req = client.post(root + "/requests", json={"quantity": "voltage", "meter_mode": "DC_voltage", "red_node_id": "B", "black_node_id": "GND"}).json()
        pending = client.post(root + "/candidates", json={"request_id": req["request_id"], "text": "0.275 V"}).json()
        conf = pending["confirmation"]
        client.post(root + "/readback", json={"confirmation_id": conf["confirmation_id"]})
        accepted = client.post(root + "/confirm", json={key: conf[key] for key in ("confirmation_id", "candidate_id", "request_id", "measurement_context_hash", "revisions")}).json()
        assert accepted["payload"]["evidence_kind"] == "user_reported_physical_measurement"
        report = client.get(root + "/report").json()["markdown"]
        assert "user_reported_physical_measurement" in report
        assert "Physical verification: pending" in report
        # This automated API test used synthetic input; no physical reading was taken.
        answer = client.post(root + "/question", json={"text": "What reading did I report?"}).json()
        assert "confirmed user-reported reading is 0.275 V" in answer["text"]
        assert "practice" not in answer["text"].lower()
        assert any("not instrument verified" in item for item in answer["limitations"])
