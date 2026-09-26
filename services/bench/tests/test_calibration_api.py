from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


def _sample(yaw, pitch):
    return {"yaw_deg": float(yaw), "pitch_deg": float(pitch), "dx_px": 12.0*yaw+3.0*pitch, "dy_px": -2.0*yaw+15.0*pitch}


def test_calibration_candidate_never_applies_or_arms_hardware(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={}).json()
        root = f"/v1/sessions/{state['session_id']}"
        body = {"circuit_revision": state["revisions"]["circuit_revision"], "data_source": "synthetic",
                "fit_samples": [_sample(1, 0), _sample(-1, 0), _sample(0, 1), _sample(0, -1)],
                "validation_samples": [_sample(2, 1), _sample(-1, 2)]}
        response = client.post(root + "/calibration/fit", json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "accepted"
        assert result["calibration"]["jacobian_px_per_degree"] == [[12.0, 3.0], [-2.0, 15.0]]
        assert result["applied"] is False and result["hardware_armed"] is False
        assert result["physical_verification"] == "pending"
        assert result["data_source"] == "synthetic" and result["evidence_ids"]
        assert client.get(root).json()["revisions"] == state["revisions"]
        assert client.post(root + "/calibration/fit", json=body,
                           headers={"Authorization": "Bearer " + "m" * 40}).status_code == 403
        client.post(root + "/fixture", json={"name": "loaded-divider"})
        assert client.post(root + "/calibration/fit", json=body).status_code == 409


def test_singular_calibration_is_json_safe_and_contains_no_usable_fit(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={}).json()
        body = {"circuit_revision": state["revisions"]["circuit_revision"], "data_source": "user_supplied",
                "fit_samples": [_sample(x, x) for x in (-2, -1, 1, 2)],
                "validation_samples": [_sample(2, 1), _sample(-1, 2)]}
        result = client.post(f"/v1/sessions/{state['session_id']}/calibration/fit", json=body).json()
        assert result["status"] == "rejected" and result["calibration"] is None
        assert result["design_condition_number"] is None
