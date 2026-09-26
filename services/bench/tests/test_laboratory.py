from __future__ import annotations

from pathlib import Path

import pytest

from ohmpath.circuits import laboratory


def test_rc_transient_is_actual_and_matches_one_tau(tmp_path: Path) -> None:
    result = laboratory.run_rc_transient(work_root=tmp_path)

    assert result["status"] == "succeeded", result["error"]
    assert result["provenance"] == "ngspice_actual"
    assert result["simulator_sha256"] and result["netlist_sha256"]
    assert len(result["trace"]) == 201
    reference = result["analytic_reference"]
    assert reference["crossing_within_2_percent"]
    assert reference["actual_voltage_nearest_one_tau_v"] == pytest.approx(
        reference["ideal_voltage_at_one_tau_v"], rel=0.01
    )
    assert "PULSE(" in result["netlist"]


def test_diode_sweep_is_actual_monotonic_and_resistor_consistent(tmp_path: Path) -> None:
    result = laboratory.run_diode_sweep(work_root=tmp_path)

    assert result["status"] == "succeeded", result["error"]
    assert result["provenance"] == "ngspice_actual"
    assert result["model_id"] == "ohmpath.educational-shockley-silicon.v1"
    sweep = result["sweep"]
    assert len(sweep) == 101
    currents = [point["current_a"] for point in sweep]
    assert all(a <= b for a, b in zip(currents, currents[1:]))
    resistance = result["parameters"]["resistance_ohm"]
    for point in sweep:
        assert point["current_a"] == pytest.approx(
            (point["supply_v"] - point["diode_voltage_v"]) / resistance,
            abs=1e-7,
        )
    reference = result["shockley_reference"]
    assert reference["checked_forward_points"] > 0
    assert reference["maximum_relative_current_difference"] < 0.02
    assert "not a vendor-certified" in reference["note"]


@pytest.mark.parametrize(
    "call",
    [
        lambda root: laboratory.run_rc_transient(resistance_ohm=99, work_root=root),
        lambda root: laboratory.run_rc_transient(capacitance_f=float("nan"), work_root=root),
        lambda root: laboratory.run_rc_transient(supply_v=5.01, work_root=root),
        lambda root: laboratory.run_diode_sweep(resistance_ohm=99, work_root=root),
        lambda root: laboratory.run_diode_sweep(maximum_supply_v=5.01, work_root=root),
    ],
)
def test_out_of_bounds_parameters_are_rejected_before_simulation(tmp_path: Path, call) -> None:
    with pytest.raises(ValueError):
        call(tmp_path)


def test_missing_simulator_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(laboratory, "_resolve_ngspice", lambda: None)

    result = laboratory.run_rc_transient(work_root=tmp_path)

    assert result["status"] == "failed"
    assert result["provenance"] == "none"
    assert result["trace"] == []
    assert result["error"] == "ngspice executable was not found"


def test_numeric_output_cap_and_malformed_rows_fail_closed() -> None:
    with pytest.raises(ValueError, match="250 KB"):
        laboratory._parse_data_rows(b"x" * (laboratory.MAX_DATA_OUTPUT_BYTES + 1), columns=2, max_points=201)
    with pytest.raises(ValueError, match="malformed"):
        laboratory._parse_data_rows(b"0 1\nnot-a-number\n", columns=2, max_points=201)
    with pytest.raises(ValueError, match="missing or non-finite"):
        laboratory._parse_data_rows(b"0 1 2\n", columns=2, max_points=201)


def test_simulator_convergence_error_never_returns_trace(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    executable = laboratory._resolve_ngspice()
    assert executable is not None, "actual ngspice installation required for this suite"
    monkeypatch.setattr(laboratory, "_resolve_ngspice", lambda: executable)
    monkeypatch.setattr(laboratory, "_version", lambda _path: "test ngspice")

    class FatalSimulator:
        returncode = 0

        def __init__(self, _args, **kwargs):
            kwargs["stdout"].write(b"Fatal error: failed to converge\n")

        def poll(self):
            return self.returncode

    monkeypatch.setattr(laboratory.subprocess, "Popen", FatalSimulator)
    result = laboratory.run_rc_transient(work_root=tmp_path)

    assert result["status"] == "failed"
    assert result["provenance"] == "ngspice_actual"
    assert result["trace"] == []
    assert "convergence" in result["error"]


def test_child_timeout_never_returns_simulated_data(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    executable = laboratory._resolve_ngspice()
    assert executable is not None, "actual ngspice installation required for this suite"
    monkeypatch.setattr(laboratory, "_resolve_ngspice", lambda: executable)
    monkeypatch.setattr(laboratory, "_version", lambda _path: "test ngspice")
    monkeypatch.setattr(laboratory, "RUN_TIMEOUT_S", 0.001)

    class StalledSimulator:
        returncode = None

        def __init__(self, _args, **_kwargs):
            pass

        def poll(self):
            return self.returncode

        def kill(self):
            self.returncode = -9

        def wait(self):
            return self.returncode

    monkeypatch.setattr(laboratory.subprocess, "Popen", StalledSimulator)
    result = laboratory.run_rc_transient(work_root=tmp_path)

    assert result["status"] == "timed_out"
    assert result["provenance"] == "ngspice_actual"
    assert result["trace"] == []
