"""Fixed educational NMOS switch cases for simulator-only fault comparisons.

The generated deck is closed over a reviewed model and five named variants.
Nothing from a circuit photo, firmware log, or model response is inserted into SPICE.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Literal

from .laboratory import _execute_fixed_netlist, _validate_work_root


SwitchCase = Literal["healthy", "gate_disconnected", "load_open", "device_open", "device_shorted"]

SUPPLY_V = 3.3
LOAD_OHM = 1_000.0
GATE_PULLDOWN_OHM = 100_000.0
MODEL_ID = "ohmpath.educational-level1-nmos.v1"
_MODEL = ".model OHMPATH_EDU_NMOS NMOS(Level=1 Vto=1 Kp=0.05 Lambda=0.02)"
_CASES: tuple[SwitchCase, ...] = (
    "healthy", "gate_disconnected", "load_open", "device_open", "device_shorted",
)


def supported_switch_cases() -> tuple[SwitchCase, ...]:
    return _CASES


def _netlist(case: SwitchCase) -> str:
    load_ohm = 1e12 if case == "load_open" else LOAD_OHM
    gate_ohm = 1e12 if case == "gate_disconnected" else 100.0
    device = (
        "RDEVICE drain 0 1e12" if case == "device_open" else
        "RDEVICE drain 0 0.01" if case == "device_shorted" else
        "M1 drain gate 0 0 OHMPATH_EDU_NMOS W=1u L=1u"
    )
    return "\n".join((
        "Ohm Path fixed educational NMOS switch",
        ".option noacct",
        ".temp 27",
        f"VDD supply 0 DC {SUPPLY_V:g}",
        "VDRIVE drive 0 DC 0",
        f"RLOAD supply drain {load_ohm:g}",
        "RLEAK drain 0 100000000",
        f"RGATE drive gate {gate_ohm:g}",
        f"RPULL gate 0 {GATE_PULLDOWN_OHM:g}",
        device,
        _MODEL,
        ".control",
        "set noaskquit",
        "set wr_singlescale",
        f"dc VDRIVE 0 {SUPPLY_V:g} {SUPPLY_V:g}",
        "wrdata switch-points.dat v(gate) v(drain) i(VDD)",
        "quit",
        ".endc",
        ".end",
        "",
    ))


def run_switch_case(case: SwitchCase, *, work_root: Path) -> dict[str, Any]:
    """Simulate drive low/high with a fixed active-device model and named fault."""
    if case not in _CASES:
        raise ValueError("unknown curated NMOS switch case")
    _validate_work_root(work_root)
    load_ohm = 1e12 if case == "load_open" else LOAD_OHM

    def parse(rows: list[list[float]]) -> dict[str, Any]:
        if len(rows) != 2:
            raise ValueError("NMOS switch expected exactly two drive points")
        points = []
        for expected_drive, (drive, gate, drain, source_current) in zip((0.0, SUPPLY_V), rows):
            if not math.isclose(drive, expected_drive, abs_tol=1e-7):
                raise ValueError("NMOS switch returned an unexpected drive value")
            current = -source_current
            from_load = (SUPPLY_V - drain) / load_ohm
            if not all(math.isfinite(value) for value in (gate, drain, current)):
                raise ValueError("NMOS switch returned a non-finite result")
            if not (-0.01 <= gate <= SUPPLY_V + 0.01 and
                    -0.01 <= drain <= SUPPLY_V + 0.01 and
                    -1e-7 <= current <= 0.01):
                raise ValueError("NMOS switch returned an out-of-range result")
            if not math.isclose(current, from_load, abs_tol=1e-7, rel_tol=0.01):
                raise ValueError("NMOS switch failed the load-current consistency check")
            points.append({
                "drive_v": drive, "gate_v": gate, "drain_v": drain,
                "supply_current_a": current,
            })
        return {"points": points}

    result = _execute_fixed_netlist(
        _netlist(case), output_name="switch-points.dat", columns=4,
        max_points=2, work_root=work_root, postprocess=parse,
    )
    data = result.pop("data")
    return {
        **result,
        "analysis": "educational_nmos_switch_dc",
        "case": case,
        "model_id": MODEL_ID,
        "parameters": {
            "supply_v": SUPPLY_V, "load_ohm": load_ohm,
            "gate_pulldown_ohm": GATE_PULLDOWN_OHM,
        },
        "points": data["points"] if data else [],
        "limitations": [
            "Fixed educational level-1 NMOS model, not a model of a named physical transistor.",
            "Open and short cases use finite resistor proxies; no physical fault is identified from simulation alone.",
            "A fixed 100 MΩ drain leakage path gives an open load a defined simulated voltage.",
            "No component tolerance, thermal behavior, switching transient, or physical measurement is represented.",
        ],
    }
