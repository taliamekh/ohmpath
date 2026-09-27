"""Saved circuit API/contract checks; no model or physical device calls."""
import hashlib
from uuid import uuid4

from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.contracts import PhotoCircuitModel
from ohmpath.session.store import validate_contract

USER = "u" * 40
MODEL = "m" * 40
HEADERS = {"Authorization": f"Bearer {USER}"}
REV = hashlib.sha256(b"test-photo").hexdigest()


def candidate():
    return {"intended_function": "Unknown resistor network",
            "components": [{"ref": "R1", "kind": "resistor", "nodes": ["VIN", None],
                            "value_si": None, "source": "image_visible",
                            "value_source": "unknown", "connection_source": "unknown"}],
            "ground_node": None, "ground_source": "unknown",
            "assumptions": [], "uncertainties": [], "unsupported": []}


def test_saved_circuit_is_private_read_only_and_clearable(tmp_path):
    app = create_app(tmp_path, USER, MODEL)
    context = str(uuid4())
    route = f"/v1/photo-help/contexts/{context}"
    with TestClient(app) as client:
        assert client.get(route).status_code == 401
        assert client.get(route, headers={"Authorization": f"Bearer {MODEL}"}).status_code == 403
        assert client.get(route, headers=HEADERS).json() == {"circuit_model": None}
        assert client.get("/v1/photo-help/contexts/not-a-uuid", headers=HEADERS).status_code == 422
        remembered = app.state.photo_help.reconstruction.remember(context, REV, candidate())
        response = client.get(route, headers=HEADERS)
        assert response.status_code == 200
        model = response.json()["circuit_model"]
        assert model == remembered
        validate_contract("PhotoCircuitModel", model)
        PhotoCircuitModel.model_validate(model)
        assert not app.state.photo_help.jobs  # Reading starts no model turn.
        assert client.post("/v1/photo-help/cancel", headers=HEADERS,
                           json={"context_id": context}).status_code == 200
        assert client.get(route, headers=HEADERS).json() == {"circuit_model": None}


def test_restart_recovers_parts_without_predictions(tmp_path):
    context = str(uuid4())
    first = create_app(tmp_path, USER, MODEL)
    with TestClient(first):
        first.state.photo_help.reconstruction.remember(context, REV, candidate())
    second = create_app(tmp_path, USER, MODEL)
    with TestClient(second) as client:
        model = client.get(f"/v1/photo-help/contexts/{context}", headers=HEADERS).json()["circuit_model"]
        assert model["draft"]["components"] == candidate()["components"]
        assert model["draft"]["simulation_ready"] is False
        assert model["draft"]["questions"][0]["issue"] == "restored draft needs review"
        assert model["simulation"] is None
        validate_contract("PhotoCircuitModel", model)
        PhotoCircuitModel.model_validate(model)
