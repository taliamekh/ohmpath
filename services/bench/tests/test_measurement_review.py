"""Cross-layer regression probes for confirmation and contract edge cases."""

import pytest

from ohmpath.contracts import MeasurementCandidate
from ohmpath.session.measurements import Measurements
from ohmpath.session.store import DomainError, SessionStore


def voltage_request(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite")
    sid = store.create()["session_id"]
    measurements = Measurements(store)
    measurements.setup(sid, "on_current_limited", {"low_voltage_confirmed": True})
    request = measurements.request(sid, "voltage", "DC_voltage", "VIN", "0")
    return store, measurements, sid, request


@pytest.fixture
def bench(tmp_path, request):
    store, measurements, sid, active_request = voltage_request(tmp_path)
    request.addfinalizer(store.close)
    return store, measurements, sid, active_request


def test_overload_ocr_candidate_can_complete_explicit_confirmation(bench):
    """OL is an allowed distinct display state, so it should remain confirmable."""
    store, measurements, sid, request = bench
    candidate = MeasurementCandidate(
        candidate_id="candidate-ol", request_id=request["request_id"], original_text="OL",
        value=None, si_unit=None, original_unit=None, original_number=None,
        display_state="over_limit", source="ocr", ambiguities=[],
    )

    def capture(state, emit):
        return measurements._capture(state, emit, request, candidate)

    captured = store.transact(sid, capture)
    confirmation = captured["confirmation"]
    completed = measurements.readback(sid, confirmation["confirmation_id"])

    event = measurements.confirm(
        sid, completed["confirmation_id"], candidate.candidate_id, request["request_id"],
        request["measurement_context_hash"], request["revisions"],
    )
    assert event["event_type"] == "measurement.confirmed"
    assert event["payload"]["candidate"]["display_state"] == "over_limit"


def test_oversized_candidate_is_rejected_as_domain_input_not_schema_failure(bench):
    """The shared schema caps candidate text at 4096 chars; API input should fail cleanly."""
    store, measurements, sid, request = bench
    with pytest.raises(DomainError) as error:
        measurements.typed_candidate(sid, "1 V" + (" " * 4096), request["request_id"])
    assert error.value.code == "measurement_candidate_invalid"


def test_request_empty_range_and_instrument_are_rejected(bench):
    """The shared request contract marks these strings minLength=1."""
    store, measurements, sid, _ = bench
    with pytest.raises(DomainError) as error:
        measurements.request(
            sid, "voltage", "DC_voltage", "VIN", "0", meter_range="", instrument_id="",
        )
    assert error.value.code == "measurement_request_invalid"


def _confirm_reading(measurements, sid, request, text="1 V", supersedes=None):
    pending = measurements.typed_candidate(sid, text, request["request_id"])
    confirmation = measurements.readback(sid, pending["confirmation"]["confirmation_id"])
    keys = ("confirmation_id", "candidate_id", "request_id", "measurement_context_hash", "revisions")
    return measurements.confirm(sid, **{key: confirmation[key] for key in keys}, supersedes_event_id=supersedes)


def test_correction_cannot_remove_reading_at_other_probe_endpoints(bench):
    store, measurements, sid, request = bench
    original = _confirm_reading(measurements, sid, request)
    next_request = measurements.request(sid, "voltage", "DC_voltage", "MID", "0")
    with pytest.raises(DomainError, match="same circuit, probes"):
        _confirm_reading(measurements, sid, next_request, supersedes=original["event_id"])
    assert [event["event_id"] for event in store.current_measurements(sid, original["circuit_revision"])] == [original["event_id"]]


def test_correction_replaces_only_current_record_in_same_context(bench):
    store, measurements, sid, request = bench
    original = _confirm_reading(measurements, sid, request)
    next_request = measurements.request(sid, "voltage", "DC_voltage", "VIN", "0")
    replacement = _confirm_reading(measurements, sid, next_request, "1.1 V", original["event_id"])
    assert [event["event_id"] for event in store.current_measurements(sid, original["circuit_revision"])] == [replacement["event_id"]]
    next_request = measurements.request(sid, "voltage", "DC_voltage", "VIN", "0")
    with pytest.raises(DomainError, match="latest replacement"):
        _confirm_reading(measurements, sid, next_request, "1.2 V", original["event_id"])
