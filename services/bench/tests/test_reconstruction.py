"""The photo draft is not a fixture substitute or physical measurement."""

from __future__ import annotations

import copy
import hashlib
import threading
from uuid import uuid4

import pytest

from ohmpath.circuits.reconstruction import CircuitReconstruction, DraftError
from ohmpath.circuits.simulation import _resolve_simulator


REV = hashlib.sha256(b"first-photo").hexdigest()
REV2 = hashlib.sha256(b"closer-photo").hexdigest()


def candidate():
    def part(ref, kind, nodes, value):
        return {"ref": ref, "kind": kind, "nodes": nodes, "value_si": value,
                "source": "image_visible", "value_source": "user_reported",
                "connection_source": "user_reported"}
    return {"intended_function": "A user-described 6 V divider, actual wiring still unconfirmed",
            "components": [part("V1", "dc_voltage_source", ["VIN", "GND"], 6),
                           part("R1", "resistor", ["VIN", "MID"], 1000),
                           part("R2", "resistor", ["MID", "GND"], 2000)],
            "ground_node": "GND", "ground_source": "user_reported",
            "assumptions": [], "uncertainties": [], "unsupported": []}


def test_new_nonfixture_graph_runs_actual_ngspice(tmp_path):
    if _resolve_simulator(None) is None:
        pytest.skip("ngspice executable unavailable")
    context = str(uuid4())
    store = CircuitReconstruction(tmp_path)
    remembered = store.remember(context, REV, candidate())
    draft = remembered["draft"]
    assert draft["simulation_ready"]
    result = store.simulate(context, REV, draft["draft_revision"])
    assert result["status"] == "succeeded"
    assert result["provenance"] == "ngspice_actual"
    assert result["conditional"] is True
    assert result["node_voltages_v"]["MID"] == pytest.approx(4.0, abs=.002)
    assert store.snapshot(context)["simulation"]["graph_sha256"] == draft["graph_sha256"]
    restored = CircuitReconstruction(tmp_path).snapshot(context)
    assert restored["draft"]["components"] == draft["components"]
    assert restored["draft"]["simulation_ready"] is False
    assert restored["simulation"] is None


@pytest.mark.parametrize("change,needle", [
    (lambda value: value["components"][1].update(value_si=None, value_source="unknown"), "R1"),
    (lambda value: value["components"][1].update(nodes=["VIN", None]), "R1 terminal 2"),
    (lambda value: value["components"][1].update(kind="capacitor"), "R1"),
    (lambda value: value["components"][1].update(source="assumed"), "R1"),
    (lambda value: value.update(unsupported=["U1 is visible but unidentified"]), "U1"),
])
def test_unknown_or_unsupported_part_blocks_without_silent_drop(change, needle):
    context = str(uuid4())
    value = candidate()
    change(value)
    store = CircuitReconstruction()
    draft = store.remember(context, REV, value)["draft"]
    assert not draft["simulation_ready"]
    assert needle in str(draft["questions"])
    result = store.simulate(context, REV, draft["draft_revision"])
    assert result["status"] == "blocked"
    assert result["provenance"] == "none"
    assert result["node_voltages_v"] == {}


def test_correction_revision_and_new_photo_revoke_previous_simulation(tmp_path):
    context = str(uuid4())
    store = CircuitReconstruction(tmp_path)
    first = store.remember(context, REV, candidate())["draft"]
    correction = candidate()
    correction["components"][2]["value_si"] = 3000
    second = store.remember(context, REV, correction)["draft"]
    assert second["draft_revision"] != first["draft_revision"]
    with pytest.raises(DraftError, match="stale"):
        store.simulate(context, REV, first["draft_revision"])
    carried = store.carry_forward(context, REV2)["draft"]
    assert carried["components"] == second["components"]
    assert not carried["simulation_ready"]
    assert carried["prior_image_revision"] == REV
    assert carried["questions"][0]["target"] == "whole circuit"
    assert store.simulate(context, REV2, carried["draft_revision"])["status"] == "blocked"
    third = store.remember(context, REV2, correction)["draft"]
    assert third["simulation_ready"]
    assert third["draft_revision"] != second["draft_revision"]
    store.clear(context)
    assert store.snapshot(context) is None


def test_closeup_cannot_silently_drop_original_components():
    context = str(uuid4())
    store = CircuitReconstruction()
    first = store.remember(context, REV, candidate())["draft"]
    store.carry_forward(context, REV2)
    closeup = candidate()
    closeup["components"] = [closeup["components"][2]]
    closeup["components"][0]["value_si"] = 2200
    draft = store.remember(context, REV2, closeup)["draft"]
    assert {part["ref"] for part in draft["components"]} == {"V1", "R1", "R2"}
    assert draft["retained_refs"] == ["V1", "R1"]
    assert draft["simulation_ready"]
    assert draft["draft_revision"] != first["draft_revision"]


def test_invalid_saved_state_is_ignored(tmp_path):
    path = tmp_path / "photo-circuit-drafts.json"
    path.write_text('{"bad":{"draft":{"simulation_ready":true}}}', encoding="utf-8")
    assert CircuitReconstruction(tmp_path).snapshot("bad") is None
    path.write_bytes(b"x" * 1_000_001)
    assert CircuitReconstruction(tmp_path).records == {}


def test_simulation_result_is_rejected_after_concurrent_correction(monkeypatch):
    context = str(uuid4())
    store = CircuitReconstruction()
    first = store.remember(context, REV, candidate())["draft"]
    started, release = threading.Event(), threading.Event()
    from ohmpath.circuits import reconstruction
    original_run = reconstruction.run_operating_point
    def delayed(*args, **kwargs):
        started.set()
        assert release.wait(3)
        return original_run(*args, **kwargs)
    monkeypatch.setattr(reconstruction, "run_operating_point", delayed)
    outcome = []
    worker = threading.Thread(target=lambda: outcome.append(
        pytest.raises(DraftError, store.simulate, context, REV, first["draft_revision"])))
    worker.start()
    assert started.wait(2)
    corrected = candidate()
    corrected["components"][2]["value_si"] = 3300
    store.remember(context, REV, corrected)
    release.set()
    worker.join(5)
    assert outcome and store.snapshot(context)["simulation"] is None


def test_invalid_and_cancelled_drafts_never_replace_saved_state():
    context = str(uuid4())
    store = CircuitReconstruction()
    original = store.remember(context, REV, candidate())
    injection = candidate()
    injection["components"][0]["nodes"] = ["VIN", "GND; .include secret"]
    with pytest.raises(DraftError):
        store.remember(context, REV, injection)
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(DraftError, match="cancelled"):
        store.remember(context, REV, copy.deepcopy(candidate()), cancel_event=cancelled)
    assert store.snapshot(context) == original
