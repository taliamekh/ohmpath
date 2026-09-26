import base64
from pathlib import Path
import pytest

from fastapi.testclient import TestClient

from ohmpath.api.app import create_app


def test_assembly_firmware_aiming_and_import_are_local_user_capabilities(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={}).json()
        sid = state["session_id"]
        root = f"/v1/sessions/{sid}"
        guide = client.get(root + "/assembly").json()
        assert guide["physical_verification"] == "pending"
        assert all(step["requires_unpowered"] for step in guide["steps"])
        report = client.post(root + "/firmware/analyze", json={"log_text": "boot\nboot\nboot\nbrownout", "baud_rate": 115200}).json()
        assert report["source"] == "user_supplied_log"
        assert {h["title"] for h in report["hypotheses"]} >= {"boot loop", "power integrity"}
        result = client.post(root + "/aim/demo", json={"target_x": 380., "target_y": 200.}).json()
        assert result["mode"] == "simulation" and result["laser_enabled"] is False
        assert result["converged"]
        denied = client.post(root + "/aim/demo", headers={"Authorization": "Bearer " + "m" * 40}, json={"target_x": 380., "target_y": 200.})
        assert denied.status_code == 403
        client.post(root + "/pause")
        stopped = client.post(root + "/aim/demo", json={"target_x": 380., "target_y": 200.})
        assert stopped.status_code == 409 and stopped.json()["error"] == "session_paused"
        assert client.post(root + "/imports", json={"schematic_base64": base64.b64encode(b"not a schematic").decode()}).status_code == 422


def test_real_kicad_preview_requires_separate_acceptance_and_keeps_source_private(tmp_path):
    from ohmpath.circuits.kicad import _DEFAULT_KICAD_CLI
    if not _DEFAULT_KICAD_CLI.is_file():
        pytest.skip("The reviewed local KiCad executable is unavailable")
    source = Path(__file__).resolve().parents[3] / "fixtures/circuits/kicad/passive-source.kicad_sch"
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={}).json()
        sid = state["session_id"]
        root = f"/v1/sessions/{sid}"
        preview = client.post(root + "/imports", json={"schematic_base64": base64.b64encode(source.read_bytes()).decode()})
        assert preview.status_code == 200, preview.text
        assert client.get(root).json()["revisions"] == state["revisions"]
        selected = client.post(root + "/imports/accept", json={"import_id": preview.json()["import_id"]}).json()
        assert selected["fixture"] == "imported"
        assert selected["revisions"]["circuit_revision"] != state["revisions"]["circuit_revision"]
        graph = client.get(root + "/graph").json()
        assert graph["evidence_ids"]
        solved = client.post(root + "/simulate").json()["payload"]
        assert solved["status"] == "succeeded"
        assert 3.3 in solved["node_voltages_v"].values()
        assert list((tmp_path / "imports" / sid).rglob("source.kicad_sch"))


def test_recent_history_and_model_graph_remain_available_after_many_events(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        sid = client.post("/v1/sessions", json={}).json()["session_id"]
        def many(state, emit):
            for n in range(510):
                emit("test.replayed", {"ordinal": n})
        app.state.store.transact(sid, many)
        recent = client.get(f"/v1/sessions/{sid}/events?tail=true").json()
        assert len(recent) == 100 and recent[-1]["payload"]["ordinal"] == 509
        assert client.get(f"/v1/sessions/{sid}/graph").json()["evidence_ids"]
        evidence = client.get(f"/v1/sessions/{sid}/evidence", headers={"Authorization": "Bearer " + "m" * 40}).json()
        assert evidence["evidence_ids"] and evidence["physical_verification"] == "pending"


def test_laboratory_is_separate_from_selected_circuit_and_rejects_model_mutation(tmp_path):
    from ohmpath.circuits.laboratory import _resolve_ngspice
    if _resolve_ngspice() is None:
        pytest.skip("ngspice is unavailable")
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app, headers={"Authorization": "Bearer " + "u" * 40}) as client:
        state = client.post("/v1/sessions", json={}).json()
        root = f"/v1/sessions/{state['session_id']}"
        result = client.post(root + "/laboratory", json={"template": "rc"}).json()
        assert result["status"] == "succeeded"
        assert result["provenance"] == "ngspice_actual" and len(result["trace"]) == 201
        assert result["scope"] == "independent_educational_template_not_selected_circuit"
        assert result["evidence_ids"]
        assert client.get(root).json()["revisions"] == state["revisions"]
        assert not app.state.store.current_measurements(state["session_id"], state["revisions"]["circuit_revision"])
        assert client.post(root + "/laboratory", json={"template": "rc", "supply_v": 240.0}).status_code == 422
        assert client.post(root + "/laboratory", json={"template": "diode"},
                           headers={"Authorization": "Bearer " + "m" * 40}).status_code == 403
