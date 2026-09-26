from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable

from .simulation import _version


RUN_TIMEOUT_S = 5.0
MAX_PROCESS_OUTPUT_BYTES = 100_000
MAX_DATA_OUTPUT_BYTES = 250_000
MAX_NETLIST_BYTES = 12_000
MAX_TRACE_POINTS = 201
_DEFAULT_NGSPICE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs/ngspice-47/Spice64/bin/ngspice_con.exe"
_NUMBER_ROW = re.compile(r"^\s*([-+0-9.eE]+)(?:\s+([-+0-9.eE]+))?(?:\s+([-+0-9.eE]+))?(?:\s+([-+0-9.eE]+))?\s*$")
_CONVERGENCE_FAILURE = re.compile(r"singular matrix|timestep too small|failed to converge|no convergence|fatal error|fatal:", re.IGNORECASE)

_DIODE_MODEL_ID = "ohmpath.educational-shockley-silicon.v1"
_DIODE_MODEL = ".model OHMPATH_EDU_SILICON D(Is=2.52e-9 N=1.752 Rs=0.568 Cjo=4p M=0.03 Vj=0.75 Tt=4n)"
_DIODE_PARAMETERS = {
    "Is_a": 2.52e-9,
    "emission_factor_n": 1.752,
    "series_resistance_ohm": 0.568,
    "temperature_c": 27.0,
    "junction_capacitance_f": 4e-12,
    "junction_potential_v": 0.75,
    "transit_time_s": 4e-9,
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _resolve_ngspice() -> Path | None:
    requested = os.environ.get("OHMPATH_NGSPICE")
    if requested:
        candidate = Path(requested).expanduser().resolve()
        return candidate if candidate.is_file() else None
    found = shutil.which("ngspice_con.exe") or shutil.which("ngspice")
    candidate = Path(found).resolve() if found else _DEFAULT_NGSPICE
    return candidate.resolve() if candidate.is_file() else None


def _number(value: Any, *, name: str, low: float, high: float, low_open: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    number = float(value)
    if (number <= low if low_open else number < low) or number > high:
        relation = f"> {low:g}" if low_open else f">= {low:g}"
        raise ValueError(f"{name} must be {relation} and <= {high:g}")
    return number


def _spice_number(value: float) -> str:
    return format(value, ".12g")


def _parse_data_rows(raw: bytes, *, columns: int, max_points: int) -> list[list[float]]:
    if not raw or len(raw) > MAX_DATA_OUTPUT_BYTES:
        raise ValueError("ngspice data file is empty or exceeds the 250 KB limit")
    text = raw.decode("ascii", errors="strict")
    rows: list[list[float]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _NUMBER_ROW.fullmatch(line)
        if not match:
            raise ValueError("ngspice data contains a malformed numeric row")
        row = [float(item) for item in match.groups()[:columns] if item is not None]
        if len(row) != columns or not all(math.isfinite(item) for item in row):
            raise ValueError("ngspice data has missing or non-finite values")
        if any(abs(item) > 1e15 for item in row):
            raise ValueError("ngspice data value exceeds the accepted numeric range")
        if len(rows) >= max_points:
            raise ValueError(f"ngspice returned more than {max_points} data points")
        rows.append(row)
    if not rows:
        raise ValueError("ngspice returned no numeric rows")
    return rows


def _execute_fixed_netlist(
    netlist: str,
    *,
    output_name: str,
    columns: int,
    max_points: int,
    work_root: Path,
    postprocess: Callable[[list[list[float]]], Any],
) -> dict[str, Any]:
    encoded = netlist.encode("ascii")
    if len(encoded) > MAX_NETLIST_BYTES:
        raise ValueError("generated fixed-template netlist exceeds its size bound")
    common: dict[str, Any] = {
        "simulation_id": str(uuid.uuid4()),
        "status": "failed",
        "provenance": "none",
        "simulator_sha256": None,
        "simulator_version": None,
        "netlist_sha256": _sha256(encoded),
        "duration_s": 0.0,
        "netlist": netlist,
        "stdout": "",
        "stderr": "",
        "data": None,
        "exit_code": None,
        "error": None,
    }
    executable = _resolve_ngspice()
    if executable is None:
        common["error"] = "ngspice executable was not found"
        return common
    try:
        common["simulator_sha256"] = _sha256(executable.read_bytes())
    except OSError as exc:
        common["error"] = f"ngspice executable could not be hashed: {type(exc).__name__}"
        return common
    common["simulator_version"] = _version(executable)
    start = time.monotonic()
    try:
        work_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ohmpath-lab-", dir=str(work_root.resolve())) as run_dir:
            run = Path(run_dir)
            netlist_path = run / "approved-lab.cir"
            output_path = run / output_name
            stdout_path = run / "stdout.log"
            stderr_path = run / "stderr.log"
            netlist_path.write_bytes(encoded)
            with stdout_path.open("wb") as stdout_file, stderr_path.open("wb") as stderr_file:
                process = subprocess.Popen(
                    [str(executable), "-b", str(netlist_path)], cwd=run,
                    stdout=stdout_file, stderr=stderr_file, shell=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                deadline = start + RUN_TIMEOUT_S
                status_error: str | None = None
                while process.poll() is None:
                    log_size = stdout_path.stat().st_size + stderr_path.stat().st_size
                    data_size = output_path.stat().st_size if output_path.exists() else 0
                    if log_size > MAX_PROCESS_OUTPUT_BYTES:
                        process.kill()
                        process.wait()
                        status_error = "ngspice stdout/stderr exceeded the 100 KB limit"
                        break
                    if data_size > MAX_DATA_OUTPUT_BYTES:
                        process.kill()
                        process.wait()
                        status_error = "ngspice numeric output exceeded the 250 KB limit"
                        break
                    if time.monotonic() >= deadline:
                        process.kill()
                        process.wait()
                        common["status"] = "timed_out"
                        status_error = f"ngspice exceeded the {RUN_TIMEOUT_S:g} second time limit"
                        break
                    time.sleep(0.01)
                common["exit_code"] = process.returncode
                common["status"] = common["status"] if common["status"] == "timed_out" else "failed"
                stdout_size = stdout_path.stat().st_size
                stderr_size = stderr_path.stat().st_size
                data_size = output_path.stat().st_size if output_path.exists() else 0
                if stdout_size + stderr_size > MAX_PROCESS_OUTPUT_BYTES:
                    status_error = "ngspice stdout/stderr exceeded the 100 KB limit"
                elif data_size > MAX_DATA_OUTPUT_BYTES:
                    status_error = "ngspice numeric output exceeded the 250 KB limit"
            common["stdout"] = stdout_path.read_bytes()[:MAX_PROCESS_OUTPUT_BYTES].decode("utf-8", errors="replace")
            common["stderr"] = stderr_path.read_bytes()[:MAX_PROCESS_OUTPUT_BYTES].decode("utf-8", errors="replace")
            common["duration_s"] = time.monotonic() - start
            common["provenance"] = "ngspice_actual"
            if status_error is not None:
                common["error"] = status_error
                return common
            if process.returncode != 0:
                common["error"] = f"ngspice exited with status {process.returncode}"
                return common
            combined_logs = common["stdout"] + "\n" + common["stderr"]
            if _CONVERGENCE_FAILURE.search(combined_logs):
                common["error"] = "ngspice reported a convergence or fatal analysis error"
                return common
            if not output_path.is_file():
                common["error"] = "ngspice did not produce its expected numeric output"
                return common
            rows = _parse_data_rows(output_path.read_bytes(), columns=columns, max_points=max_points)
            common["data"] = postprocess(rows)
            common["status"] = "succeeded"
            return common
    except subprocess.TimeoutExpired:
        common["status"] = "timed_out"
        common["error"] = f"ngspice exceeded the {RUN_TIMEOUT_S:g} second time limit"
    except (OSError, ValueError, UnicodeError, ArithmeticError) as exc:
        if common["status"] != "timed_out":
            common["status"] = "failed"
        common["error"] = str(exc)[:300]
    common["duration_s"] = time.monotonic() - start
    return common


def _validate_work_root(work_root: Path) -> None:
    if not isinstance(work_root, Path):
        raise TypeError("work_root must be a pathlib.Path")


def run_rc_transient(
    resistance_ohm: float = 1000.0,
    capacitance_f: float = 1e-6,
    supply_v: float = 3.3,
    *,
    work_root: Path,
) -> dict[str, Any]:
    """Run a fixed series-R/shunt-C step response; no user netlist text is accepted."""
    _validate_work_root(work_root)
    resistance = _number(resistance_ohm, name="resistance_ohm", low=100.0, high=1_000_000.0)
    capacitance = _number(capacitance_f, name="capacitance_f", low=1e-9, high=1e-3)
    supply = _number(supply_v, name="supply_v", low=0.1, high=5.0)
    tau = resistance * capacitance
    stop_s = 5.0 * tau
    step_s = stop_s / 200.0
    rise_s = step_s / 100.0
    netlist = "\n".join((
        "Ohm Path fixed educational RC step transient",
        ".option noacct",
        f"V1 vin 0 PULSE(0 {_spice_number(supply)} 0 {_spice_number(rise_s)} {_spice_number(rise_s)} {_spice_number(stop_s * 2)} {_spice_number(stop_s * 4)})",
        f"R1 vin vout {_spice_number(resistance)}",
        f"C1 vout 0 {_spice_number(capacitance)}",
        ".control",
        "set noaskquit",
        f"tran {_spice_number(step_s)} {_spice_number(stop_s)} 0 {_spice_number(step_s)}",
        "linearize",
        "wrdata rc-trace.dat v(vout)",
        "quit",
        ".endc",
        ".end",
        "",
    ))

    def parse(rows: list[list[float]]) -> dict[str, Any]:
        if len(rows) != MAX_TRACE_POINTS:
            raise ValueError(f"RC transient expected exactly {MAX_TRACE_POINTS} resampled points")
        trace = [{"time_s": row[0], "voltage_v": row[1]} for row in rows]
        if any(trace[i]["time_s"] >= trace[i + 1]["time_s"] for i in range(len(trace) - 1)):
            raise ValueError("RC transient times must be strictly increasing")
        if abs(trace[0]["time_s"]) > step_s * 1e-6 or abs(trace[-1]["time_s"] - stop_s) > step_s * 1e-4:
            raise ValueError("RC transient did not cover its requested time interval")
        threshold_v = supply * (1.0 - math.exp(-1.0))
        crossing_s = None
        for left, right in zip(trace, trace[1:]):
            if left["voltage_v"] <= threshold_v <= right["voltage_v"]:
                fraction = (threshold_v - left["voltage_v"]) / (right["voltage_v"] - left["voltage_v"])
                crossing_s = left["time_s"] + fraction * (right["time_s"] - left["time_s"])
                break
        if crossing_s is None:
            raise ValueError("RC transient did not cross the 63.2% reference level")
        sample = min(trace, key=lambda item: abs(item["time_s"] - tau))
        ideal_v = threshold_v
        return {
            "trace": trace,
            "analytic_reference": {
                "time_constant_s": tau,
                "ideal_voltage_at_one_tau_v": ideal_v,
                "actual_voltage_nearest_one_tau_v": sample["voltage_v"],
                "actual_63_2_percent_crossing_s": crossing_s,
                "crossing_relative_error": abs(crossing_s - tau) / tau,
                "crossing_within_2_percent": abs(crossing_s - tau) <= 0.02 * tau,
            },
        }

    result = _execute_fixed_netlist(netlist, output_name="rc-trace.dat", columns=2,
                                    max_points=MAX_TRACE_POINTS, work_root=work_root, postprocess=parse)
    data = result.pop("data")
    return {
        **result,
        "analysis": "rc_step_transient",
        "parameters": {"resistance_ohm": resistance, "capacitance_f": capacitance, "supply_v": supply},
        "provenance": result["provenance"],
        "trace": data["trace"] if data else [],
        "analytic_reference": data["analytic_reference"] if data else None,
        "limitations": ["Ideal lumped RC model; no component tolerance, source impedance, probe loading, or physical measurement is represented."],
    }


def run_diode_sweep(
    resistance_ohm: float = 1000.0,
    maximum_supply_v: float = 3.3,
    *,
    work_root: Path,
) -> dict[str, Any]:
    """Sweep a fixed educational Shockley-style silicon diode model through series R."""
    _validate_work_root(work_root)
    resistance = _number(resistance_ohm, name="resistance_ohm", low=100.0, high=1_000_000.0)
    maximum = _number(maximum_supply_v, name="maximum_supply_v", low=0.0, high=5.0, low_open=True)
    points = 101
    step_v = maximum / (points - 1)
    netlist = "\n".join((
        "Ohm Path fixed educational silicon diode sweep",
        ".option noacct",
        ".temp 27",
        "V1 vin 0 DC 0",
        f"R1 vin va {_spice_number(resistance)}",
        "D1 va 0 OHMPATH_EDU_SILICON",
        _DIODE_MODEL,
        ".control",
        "set noaskquit",
        "set wr_singlescale",
        f"dc V1 0 {_spice_number(maximum)} {_spice_number(step_v)}",
        "wrdata diode-sweep.dat v(vin) v(va) i(V1)",
        "quit",
        ".endc",
        ".end",
        "",
    ))

    def parse(rows: list[list[float]]) -> dict[str, Any]:
        if len(rows) != points:
            raise ValueError(f"diode sweep expected exactly {points} points")
        sweep = []
        previous_current = -math.inf
        for supply, scale_voltage, diode_voltage, source_current in rows:
            if abs(supply - scale_voltage) > 1e-9 or supply < -1e-9 or supply > maximum + 1e-9:
                raise ValueError("diode sweep returned an unexpected source-voltage vector")
            current = -source_current
            if current + 1e-10 < previous_current:
                raise ValueError("diode sweep current was not monotonic")
            previous_current = current
            resistor_current = (supply - diode_voltage) / resistance
            if abs(resistor_current - current) > max(1e-7, abs(current) * 0.01):
                raise ValueError("diode sweep failed the series-resistor current consistency check")
            sweep.append({"supply_v": supply, "diode_voltage_v": diode_voltage, "current_a": current})

        thermal_voltage = 8.617333262145e-5 * (273.15 + _DIODE_PARAMETERS["temperature_c"])
        checked = []
        for point in sweep:
            current = point["current_a"]
            if current <= 1e-6:
                continue
            junction_voltage = point["diode_voltage_v"] - current * _DIODE_PARAMETERS["series_resistance_ohm"]
            exponent = (junction_voltage / (_DIODE_PARAMETERS["emission_factor_n"] * thermal_voltage))
            predicted_current = _DIODE_PARAMETERS["Is_a"] * math.expm1(min(exponent, 100.0))
            if predicted_current > 0:
                checked.append(abs(current - predicted_current) / current)
        shockley_summary = {
            "model_id": _DIODE_MODEL_ID,
            "parameters": dict(_DIODE_PARAMETERS),
            "thermal_voltage_v_at_model_temperature": thermal_voltage,
            "checked_forward_points": len(checked),
            "maximum_relative_current_difference": max(checked) if checked else None,
            "note": "Fixed educational ngspice diode model, not a vendor-certified device model.",
        }
        return {"sweep": sweep, "shockley_reference": shockley_summary}

    result = _execute_fixed_netlist(netlist, output_name="diode-sweep.dat", columns=4,
                                    max_points=points, work_root=work_root, postprocess=parse)
    data = result.pop("data")
    return {
        **result,
        "analysis": "educational_silicon_diode_dc_sweep",
        "parameters": {"resistance_ohm": resistance, "maximum_supply_v": maximum,
                       "step_v": step_v, "expected_points": points},
        "model_id": _DIODE_MODEL_ID,
        "provenance": result["provenance"],
        "sweep": data["sweep"] if data else [],
        "shockley_reference": data["shockley_reference"] if data else None,
        "limitations": ["Educational generic ngspice diode model only; not vendor-certified and not validated for a specific diode.",
                        "No component tolerance, thermal variation, source uncertainty, or physical measurement is represented."],
    }
