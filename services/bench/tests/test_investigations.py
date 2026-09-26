import threading
import time
import base64
import json

import pytest
from fastapi.testclient import TestClient

from ohmpath.ai.investigations import Investigations
from ohmpath.api.app import create_app
from ohmpath.session.store import DomainError, SessionStore


def png_header(width=1, height=1):
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
            + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00\x00\x00\x00\x00")


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


def test_allowance_failure_is_actionable_without_provider_details(tmp_path):
    from ohmpath.ai.live_proof import ProofFailure
    def fail(*args, **kwargs):
        raise ProofFailure("allowance_margin_reached")
    store, sid, service = manager(tmp_path, fail)
    turn = service.start(sid, "Why?")["turn_id"]
    result = wait_job(service, sid, turn)
    assert result["error"] == "allowance_margin_reached"
    assert "local tools" in result["message"]
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


def test_reviewed_image_is_private_immutable_and_removed_after_success(tmp_path):
    original = png_header()
    observed = {}

    def runner(*args, image_path, cancel_event):
        observed["path"] = image_path
        observed["exists_during_call"] = image_path.is_file()
        observed["contents"] = image_path.read_bytes()
        observed["suffix"] = image_path.suffix
        return {"answer": "Image reviewed as user-provided context."}

    store, sid, service = manager(tmp_path, runner)
    turn = service.start(sid, "What is visible?", image_bytes=original)["turn_id"]
    assert wait_job(service, sid, turn)["status"] == "completed"
    assert observed["exists_during_call"] is True
    assert observed["contents"] == original
    assert observed["suffix"] == ".png"
    assert not observed["path"].exists()
    assert service.jobs[turn]["image_bytes"] is None
    events = store.events(sid)
    started = next(event for event in events if event["event_type"] == "investigation.started")
    metadata = started["payload"]
    assert metadata["image_attached"] is True
    assert metadata["image_sha256"]
    serialized = json.dumps(events)
    assert base64.b64encode(original).decode("ascii") not in serialized
    assert str(observed["path"]) not in serialized
    assert original.decode("latin1") not in serialized
    service.close()
    store.close()


def test_invalid_and_oversized_images_are_rejected_before_any_turn(tmp_path):
    store, sid, service = manager(tmp_path, lambda *a, **k: {"answer": "unused"})
    for payload in (b"not an image" * 4, png_header() + b"x" * 2_000_000, "not bytes"):
        with pytest.raises(DomainError) as error:
            service.start(sid, "Review", image_bytes=payload)
        assert error.value.code == "investigation_image_invalid"
    assert not any(event["event_type"] == "investigation.started" for event in store.events(sid))
    assert not service.jobs
    service.close()
    store.close()


def test_image_file_is_removed_after_runner_failure_without_leaking_path(tmp_path):
    observed = {}

    def broken(*args, image_path, cancel_event):
        observed["path"] = image_path
        assert image_path.is_file()
        raise RuntimeError(f"private image at {image_path}")

    store, sid, service = manager(tmp_path, broken)
    turn = service.start(sid, "Review", image_bytes=png_header())["turn_id"]
    result = wait_job(service, sid, turn)
    assert result["status"] == "failed"
    assert result["error"] == "investigation_failed"
    assert not observed["path"].exists()
    assert str(observed["path"]) not in json.dumps(store.events(sid))
    assert service.jobs[turn]["image_bytes"] is None
    service.close()
    store.close()


def test_cancelled_image_call_cleans_temporary_file_and_snapshot(tmp_path):
    entered = threading.Event()
    exited = threading.Event()
    observed = {}

    def waiting_runner(*args, image_path, cancel_event):
        observed["path"] = image_path
        observed["during"] = image_path.read_bytes()
        entered.set()
        cancel_event.wait(2)
        exited.set()
        return {"answer": "late"}

    image = png_header(2, 3)
    store, sid, service = manager(tmp_path, waiting_runner)
    turn = service.start(sid, "Review", image_bytes=image)["turn_id"]
    assert entered.wait(1)
    assert service.cancel(sid, turn)["status"] == "cancelled"
    assert exited.wait(1)
    worker = service.jobs[turn]["worker"]
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert observed["during"] == image
    assert not observed["path"].exists()
    assert service.jobs[turn]["image_bytes"] is None
    assert service.status(sid, turn)["status"] == "cancelled"
    assert not any(event["event_type"] == "investigation.completed" for event in store.events(sid))
    service.close()
    store.close()


def test_close_signals_worker_and_joins_for_image_cleanup(tmp_path):
    entered = threading.Event()
    observed = {}

    def cancellation_aware_runner(*args, image_path, cancel_event):
        observed["path"] = image_path
        entered.set()
        assert cancel_event.wait(2)
        return {"answer": "cancelled"}

    store, sid, service = manager(tmp_path, cancellation_aware_runner)
    turn = service.start(sid, "Review", image_bytes=png_header())["turn_id"]
    assert entered.wait(1)
    service.close()
    assert not observed["path"].exists()
    assert service.jobs[turn]["image_bytes"] is None
    store.close()
