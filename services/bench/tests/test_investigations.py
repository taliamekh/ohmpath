import threading
import time

import pytest
from fastapi.testclient import TestClient

from ohmpath.ai.investigations import Investigations
from ohmpath.api.app import create_app
from ohmpath.session.store import DomainError, SessionStore


def wait_job(manager, sid, turn):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        result = manager.status(sid, turn)
        if result["status"] != "running":
            return result
        time.sleep(.005)
    raise AssertionError("Worker did not finish")


def manager(tmp_path, runner):
    store = SessionStore(tmp_path / "state.sqlite3")
    sid = store.create()["session_id"]
    service = Investigations(store, "m" * 40, runner)
    service.base_url = "http://127.0.0.1:12345"
    return store, sid, service


def test_result_is_recorded_and_scoped_to_session(tmp_path):
    store, sid, service = manager(tmp_path, lambda *a, **k: {"answer": {"explanation": "Simulation only"}})
    turn = service.start(sid, "Why?")["turn_id"]
    assert wait_job(service, sid, turn)["status"] == "completed"
    assert store.events(sid)[-1]["event_type"] == "investigation.completed"
    with pytest.raises(DomainError):
        service.status(store.create()["session_id"], turn)
    service.close()
    store.close()


def test_cancellation_does_not_accept_late_answer_or_start_duplicate(tmp_path):
    gate = threading.Event()
    done = threading.Event()
    def runner(*args, **kwargs):
        gate.wait(2)
        done.set()
        return {"answer": "late"}
    store, sid, service = manager(tmp_path, runner)
    turn = service.start(sid, "Why?")["turn_id"]
    with pytest.raises(DomainError, match="cancel"):
        service.start(sid, "Again?")
    service.cancel(sid, turn)
    gate.set()
    done.wait(2)
    assert service.status(sid, turn)["status"] == "cancelled"
    assert not any(e["event_type"] == "investigation.completed" for e in store.events(sid))
    service.close()
    store.close()


def test_stale_revision_and_private_exception_are_not_returned(tmp_path):
    gate = threading.Event()
    def runner(*a, **k):
        gate.wait(2)
        return {"answer": "stale"}
    store, sid, service = manager(tmp_path, runner)
    turn = service.start(sid, "Why?")["turn_id"]
    store.transact(sid, lambda state, emit: state["revisions"].update(circuit_revision="changed"))
    gate.set()
    assert wait_job(service, sid, turn)["error"] == "investigation_context_changed"
    def broken(*a, **k):
        raise RuntimeError("private token / path must not escape")
    service.runner = broken
    turn = service.start(sid, "Why?")["turn_id"]
    assert wait_job(service, sid, turn)["error"] == "investigation_failed"
    service.close()
    store.close()


def test_model_cannot_start_investigation_and_pause_cancels_it(tmp_path):
    gate = threading.Event()
    app = create_app(tmp_path, "u" * 40, "m" * 40)
    app.state.investigations.base_url = "http://127.0.0.1:12345"
    def runner(*a, **k):
        gate.wait(2)
        return {"answer": "late"}
    app.state.investigations.runner = runner
    with TestClient(app) as client:
        user = {"Authorization": "Bearer " + "u" * 40}
        model = {"Authorization": "Bearer " + "m" * 40}
        sid = client.post("/v1/sessions", headers=user, json={}).json()["session_id"]
        url = f"/v1/sessions/{sid}/investigate"
        assert client.post(url, headers=model, json={"question": "Why?"}).status_code == 403
        turn = client.post(url, headers=user, json={"question": "Why?"}).json()["turn_id"]
        client.post(f"/v1/sessions/{sid}/pause", headers=user)
        assert client.get(url + "/" + turn, headers=user).json()["status"] == "cancelled"
        gate.set()
