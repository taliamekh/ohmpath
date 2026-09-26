import pytest
from fastapi.testclient import TestClient
from jsonschema import ValidationError

from ohmpath.api.app import create_app
from ohmpath.session.measurements import Measurements
from ohmpath.session.store import EVENT_VALIDATOR, DomainError, SessionStore


@pytest.fixture
def bench(tmp_path):
    store = SessionStore(tmp_path / "test.sqlite3")
    session = store.create()
    engine = Measurements(store)
    engine.setup(session["session_id"], "on_current_limited", {"load": "unchanged", "low_voltage_confirmed": True})
    yield store, engine, session["session_id"]
    store.close()


def reading(engine, sid, text="-12.5 mV"):
    req = engine.request(sid, "voltage", "DC_voltage", "MID", "0")
    pending = engine.typed_candidate(sid, text, req["request_id"])
    conf = pending["confirmation"]
    return req, pending, conf


def confirmation_args(conf):
    return {k: conf[k] for k in ("confirmation_id", "candidate_id", "request_id", "measurement_context_hash", "revisions")}


def test_round_trip_preserves_sign_units_and_mock_provenance(bench):
    store, engine, sid = bench
    req, pending, conf = reading(engine, sid)
    with pytest.raises(DomainError, match="readback"):
        engine.confirm(sid, **confirmation_args(conf))
    engine.readback(sid, conf["confirmation_id"])
    event = engine.confirm(sid, **confirmation_args(conf))
    assert event["payload"]["candidate"]["value"] == "-0.0125"
    assert event["payload"]["evidence_kind"] == "simulated_user_input"
    EVENT_VALIDATOR.validate(event)
    with pytest.raises(DomainError):
        engine.confirm(sid, **confirmation_args(conf))
    events = store.events(sid)
    assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))


def test_setup_change_invalidates_delayed_confirmation(bench):
    store, engine, sid = bench
    _, _, conf = reading(engine, sid)
    engine.readback(sid, conf["confirmation_id"])
    engine.setup(sid, "on_current_limited", {"range": "changed", "low_voltage_confirmed": True})
    with pytest.raises(DomainError):
        engine.confirm(sid, **confirmation_args(conf))
    assert not any(e["event_type"] == "measurement.confirmed" for e in store.events(sid))


@pytest.mark.parametrize("text", ["2.5", "NaN V", "2 A", "unstable", "", "2.5 or 3 V"])
def test_ambiguous_reading_has_no_confirmation(bench, text):
    _, engine, sid = bench
    _, pending, conf = reading(engine, sid, text)
    assert conf is None
    assert pending["candidate"]["ambiguities"]


def test_recovery_pauses_and_discards_pending_work(tmp_path):
    path = tmp_path / "recover.sqlite3"
    store = SessionStore(path)
    sid = store.create()["session_id"]
    engine = Measurements(store)
    engine.setup(sid, "on_current_limited", {"low_voltage_confirmed": True})
    reading(engine, sid)
    store.close()
    restored = SessionStore(path)
    state = restored.get(sid)
    assert state["status"] == "paused"
    assert state["confirmation"] is None
    assert state["hardware_state"] == "disarmed"
    assert state["power_state"] == "unknown"
    restored.close()


def test_correction_preserves_old_event(bench):
    store, engine, sid = bench
    _, _, conf = reading(engine, sid)
    engine.readback(sid, conf["confirmation_id"])
    original = engine.confirm(sid, **confirmation_args(conf))
    _, _, replacement = reading(engine, sid, "3 V")
    engine.readback(sid, replacement["confirmation_id"])
    corrected = engine.confirm(sid, **confirmation_args(replacement), supersedes_event_id=original["event_id"])
    assert corrected["supersedes_event_id"] == original["event_id"]
    assert len([e for e in store.events(sid) if e["event_type"] == "measurement.confirmed"]) == 2
    assert [e["event_id"] for e in store.current_measurements(sid, corrected["circuit_revision"])] == [corrected["event_id"]]


def test_voltage_test_requires_declaration_and_supported_circuit(bench):
    store, engine, sid = bench
    engine.setup(sid, "on_current_limited", {})
    with pytest.raises(DomainError, match="low-voltage"):
        reading(engine, sid)
    engine.setup(sid, "on_current_limited", {"low_voltage_confirmed": True})
    store.transact(sid, lambda state, emit: state.update(nominal_source_voltage_v=24.0))
    with pytest.raises(DomainError, match="12 V"):
        reading(engine, sid)


def test_ledger_schema_rejects_wrong_version_and_missing_units(bench):
    store, _, sid = bench
    event = store.events(sid)[0]
    event["schema_version"] = "2.0.0"
    with pytest.raises(ValidationError):
        EVENT_VALIDATOR.validate(event)


def test_api_capabilities_origin_and_body_bounds(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app) as client:
        assert client.get("/v1/health").status_code == 401
        user = {"Authorization": "Bearer " + "u" * 40}
        model = {"Authorization": "Bearer " + "m" * 40}
        assert client.get("/v1/health", headers=model).status_code == 200
        assert client.post("/v1/sessions", json={}, headers=model).status_code == 403
        assert client.get("/v1/health", headers={**user, "Origin": "https://evil.example"}).status_code == 403
        assert client.post("/v1/sessions", content="x" * 66000, headers=user).status_code == 413


def test_real_solver_api_and_model_proposal_never_confirms(tmp_path):
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    with TestClient(app) as client:
        user = {"Authorization": "Bearer " + "u" * 40}
        model = {"Authorization": "Bearer " + "m" * 40}
        session = client.post("/v1/sessions", json={}, headers=user).json()
        sid = session["session_id"]
        rev = session["revisions"]["circuit_revision"]
        response = client.post(f"/v1/model/sessions/{sid}/simulate", json={"circuit_revision": rev, "variant_id": "healthy"}, headers=model)
        assert response.status_code == 200
        result = response.json()
        if result["status"] == "completed":
            assert result["result"]["node_voltages_v"]["A"] == pytest.approx(2.2)
        else:
            assert result["result"]["node_voltages_v"] == {}
        proposed = client.post(f"/v1/model/sessions/{sid}/proposals", json={
            "circuit_revision": rev, "quantity": "voltage", "meter_mode": "DC_voltage",
            "red_node_id": "A", "black_node_id": "GND", "reason": "Compare with simulator output.",
            "evidence_ids": result["evidence_ids"]}, headers=model)
        assert proposed.status_code == 200
        assert client.get(f"/v1/sessions/{sid}", headers=user).json()["active_request"] is None
        assert client.post(f"/v1/sessions/{sid}/confirm", json={}, headers=model).status_code == 403
