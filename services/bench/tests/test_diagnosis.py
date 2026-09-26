from __future__ import annotations

from pathlib import Path

import pytest

from ohmpath.circuits import load_fixture
from ohmpath.circuits import diagnosis
from ohmpath.circuits.diagnosis import diagnose_circuit
from ohmpath.circuits.models import CircuitComponent, CircuitGraph, SimulationResult
from ohmpath.circuits.simulation import _resolve_simulator


NGSPICE = _resolve_simulator(None)


@pytest.mark.skipif(NGSPICE is None, reason="actual ngspice is required for diagnosis comparison verification")
def test_low_b_remains_ambiguous_and_a_is_selected_to_separate_high_r1_from_high_r2(tmp_path: Path):
    graph = load_fixture("divider")
    result = diagnose_circuit(graph, [{"red_node_id": "B", "black_node_id": "GND",
                                      "value_v": 0.275, "evidence_id": "confirmed-b-low"}],
                              work_root=tmp_path)
    by_id = {item["id"]: item for item in result["hypotheses"]}
    assert by_id["R1-high"]["status"] == "candidate"
    assert by_id["R2-high"]["status"] == "candidate"
    assert by_id["R1-high"]["comparisons"][0]["within_band"]
    assert by_id["R2-high"]["comparisons"][0]["within_band"]
    assert by_id["unknown-or-combined"]["predictions"] == {}
    assert by_id["unknown-or-combined"]["status"] == "candidate"
    assert result["next_test"]["red_node_id"] == "A"
    assert result["next_test"]["black_node_id"] == "GND"
    outcomes = result["next_test"]["predicted_outcomes_v"]
    assert outcomes["R1-high"] == pytest.approx(0.55, abs=0.01)
    assert outcomes["R2-high"] == pytest.approx(3.025, abs=0.01)
    assert all(item["status"] == "succeeded" and item["provenance"] == "ngspice_actual"
               and item["simulator_sha256"] for item in result["simulations"])
    assert "not a probability" in result["score_semantics"]
    assert "not statistically validated" in result["comparison_band_formula"]
    assert result["meter_model"]["input_resistance_ohm"] == 10_000_000


@pytest.mark.skipif(NGSPICE is None, reason="actual ngspice is required for signed comparison verification")
def test_signed_differential_readings_are_compared_with_probe_order_preserved(tmp_path: Path):
    result = diagnose_circuit(load_fixture("divider"), [
        {"red_node_id": "A", "black_node_id": "GND", "value_v": 2.2, "evidence_id": "positive-a"},
        {"red_node_id": "GND", "black_node_id": "A", "value_v": -2.2, "evidence_id": "negative-a"},
    ], work_root=tmp_path)
    healthy = next(item for item in result["hypotheses"] if item["id"] == "healthy")
    comparisons = {item["evidence_id"]: item for item in healthy["comparisons"]}
    assert comparisons["positive-a"]["predicted_v"] > 0
    assert comparisons["negative-a"]["predicted_v"] < 0
    assert comparisons["positive-a"]["within_band"]
    assert comparisons["negative-a"]["within_band"]
    assert healthy["status"] == "candidate"


@pytest.mark.skipif(NGSPICE is None, reason="actual ngspice is required for loaded path comparison")
def test_loaded_divider_low_resistance_path_has_explicit_100k_high_path_surrogate(tmp_path: Path):
    result = diagnose_circuit(load_fixture("loaded-divider"), [
        {"red_node_id": "Q", "black_node_id": "GND", "value_v": 0.30, "evidence_id": "loaded-q-low"},
    ], work_root=tmp_path)
    high_path = next(item for item in result["hypotheses"] if item["id"] == "R2-high")
    assert "100000 Ω" in high_path["title"]
    assert "contact/jumper surrogate" in high_path["assumptions"][0]
    assert high_path["status"] == "candidate"
    assert high_path["comparisons"][0]["predicted_v"] == pytest.approx(0.30, abs=0.02)
    actual = next(item for item in result["simulations"] if item["variant_id"] == "R2-high"
                  and item["meter_red_node_id"] == "Q")
    assert actual["status"] == "succeeded" and actual["provenance"] == "ngspice_actual"
    assert "R2 n" in actual["netlist"] and "100000" in actual["netlist"]


def test_failed_ngspice_result_never_becomes_zero_voltage_prediction(monkeypatch, tmp_path: Path):
    def fail_run(graph, *, timeout_s, work_root):
        return SimulationResult(
            simulation_id="failed-run", status="failed", provenance="ngspice_actual",
            graph_sha256=graph.graph_sha256, netlist_sha256="net-hash", simulator_sha256=None,
            simulator_version=None, node_voltages_v={}, exit_code=1, duration_s=0.01,
            stdout="", stderr="deliberate test failure", netlist="", error="test failure",
        )

    monkeypatch.setattr(diagnosis, "run_operating_point", fail_run)
    result = diagnose_circuit(load_fixture("divider"), [{"red_node_id": "B", "black_node_id": "GND",
                                                           "value_v": 0.275, "evidence_id": "confirmed-b-low"}],
                              work_root=tmp_path)
    assert result["simulations"]
    assert all(item["status"] == "failed" for item in result["simulations"])
    assert all(not item["predictions"] and item["prediction_provenance"] is None
               for item in result["hypotheses"])
    assert result["next_test"] is None
    assert result["provenance"] == "ngspice_failed_no_numeric_predictions"
    assert any("test failure" in item for item in result["limitations"])


def test_unknown_and_combined_case_stays_explicit_without_fabricated_result(tmp_path: Path):
    result = diagnose_circuit(load_fixture("divider"), [{"red_node_id": "B", "black_node_id": "GND",
                                                           "value_v": 0.275, "evidence_id": "confirmed-b-low"}],
                              work_root=tmp_path)
    unknown = next(item for item in result["hypotheses"] if item["id"] == "unknown-or-combined")
    assert unknown["status"] == "candidate"
    assert unknown["score"] == 0
    assert unknown["predictions"] == {}
    assert unknown["comparisons"] == []
    assert unknown["prediction_provenance"] is None


@pytest.mark.parametrize("bad", [
    {"red_node_id": "A", "black_node_id": "GND", "value_v": float("nan"), "evidence_id": "e1"},
    {"red_node_id": "missing", "black_node_id": "GND", "value_v": 1.0, "evidence_id": "e1"},
    {"red_node_id": "A", "black_node_id": "A", "value_v": 1.0, "evidence_id": "e1"},
    {"red_node_id": "A", "black_node_id": "GND", "value_v": True, "evidence_id": "e1"},
])
def test_invalid_confirmed_reading_is_rejected_before_any_simulation(bad, tmp_path: Path):
    with pytest.raises(ValueError):
        diagnose_circuit(load_fixture("divider"), [bad], work_root=tmp_path)


def test_more_than_six_resistors_and_non_path_work_root_are_rejected(tmp_path: Path):
    components = [CircuitComponent(ref="V1", kind="dc_voltage_source", nodes=("N0", "GND"),
                                   value_si=3.3, model_id="ohmpath.dc_source.v1")]
    components.extend(CircuitComponent(ref=f"R{i}", kind="resistor", nodes=(f"N{i-1}", f"N{i}"),
                                       value_si=1000, model_id="ohmpath.resistor.v1") for i in range(1, 8))
    components[-1] = CircuitComponent(ref="R7", kind="resistor", nodes=("N6", "GND"),
                                      value_si=1000, model_id="ohmpath.resistor.v1")
    too_large = CircuitGraph(circuit_id="largechain", revision="r1", ground_nodes=("GND",),
                             components=tuple(components))
    with pytest.raises(ValueError, match="at most 6 resistors"):
        diagnose_circuit(too_large, [], work_root=tmp_path)
    with pytest.raises(TypeError, match="pathlib.Path"):
        diagnose_circuit(load_fixture("divider"), [], work_root="not-a-path")
