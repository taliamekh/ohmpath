from __future__ import annotations

import json
from pathlib import Path

import pytest

from ohmpath.circuits import laboratory
from ohmpath.circuits.active_switch import run_switch_case, supported_switch_cases


FIXTURE = Path(__file__).resolve().parents[3] / "fixtures/circuits/active-switch-cases.json"


def _level(value: float, *, low: float, high: float) -> str:
    if value <= low:
        return "low"
    if value >= high:
        return "high"
    return "middle"


def test_actual_ngspice_switch_fault_cases_have_distinct_signatures(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(supported_switch_cases()) == set(fixture["cases"])
    thresholds = fixture["thresholds"]
    signatures = set()
    for case in supported_switch_cases():
        result = run_switch_case(case, work_root=tmp_path)
        assert result["status"] == "succeeded", (case, result["error"])
        assert result["provenance"] == "ngspice_actual"
        assert result["model_id"] == fixture["model_id"]
        assert result["simulator_sha256"] and result["netlist_sha256"]
        assert len(result["points"]) == 2
        signature = []
        for name, point in zip(("low", "high"), result["points"]):
            observed = {
                "gate": _level(point["gate_v"], low=thresholds["gate_low_v"], high=thresholds["gate_high_v"]),
                "drain": _level(point["drain_v"], low=thresholds["drain_low_v"], high=thresholds["drain_high_v"]),
                "current": _level(point["supply_current_a"], low=thresholds["current_low_a"], high=thresholds["current_high_a"]),
            }
            assert observed == fixture["cases"][case][name], (case, name, point)
            signature.extend(observed.values())
        signatures.add(tuple(signature))
    assert len(signatures) == len(supported_switch_cases())


def test_unknown_case_cannot_supply_simulator_directives(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown curated"):
        run_switch_case("healthy\n.control\nshell", work_root=tmp_path)


def test_missing_ngspice_fails_without_points(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(laboratory, "_resolve_ngspice", lambda: None)
    result = run_switch_case("healthy", work_root=tmp_path)
    assert result["status"] == "failed"
    assert result["provenance"] == "none"
    assert result["points"] == []
