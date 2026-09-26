from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .models import CircuitGraph, SimulationResult


_DEFAULT_NGSPICE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs/ngspice-47/Spice64/bin/ngspice_con.exe"
_FIXTURE_ROOT = Path(__file__).resolve().parents[5] / "fixtures" / "circuits"
_PRINT_LINE = re.compile(r"^\s*v\(([^)]+)\)\s*=\s*([-+0-9.eE]+)\s*$", re.MULTILINE | re.IGNORECASE)
_FAILED_ANALYSIS = re.compile(r"singular matrix|timestep too small|failed to converge|no convergence|fatal error|fatal:", re.IGNORECASE)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_fixture(name: str) -> CircuitGraph:
    """Load one of the bundled, reviewed resistor/source circuits by its fixed name."""
    if name not in {"divider", "loaded-divider"}:
        raise ValueError(f"unknown curated circuit fixture: {name!r}")
    path = _FIXTURE_ROOT / f"{name}.json"
    raw = path.read_bytes()
    graph = CircuitGraph.model_validate_json(raw)
    return graph


def generate_netlist(graph: CircuitGraph) -> str:
    """Generate the only accepted simulator input: resistor/source DC operating point."""
    nodes = sorted({node for c in graph.components for node in c.nodes} - set(graph.ground_nodes))
    aliases = {node: f"n{index}" for index, node in enumerate(nodes, start=1)}
    aliases.update({node: "0" for node in graph.ground_nodes})
    lines = ["Ohm Path generated DC operating point", ".option noacct", ".temp 27"]
    for component in graph.components:
        left, right = (aliases[n] for n in component.nodes)
        if component.kind == "resistor":
            lines.append(f"{component.ref} {left} {right} {component.value_si:.12g}")
        else:
            lines.append(f"{component.ref} {left} {right} DC {component.value_si:.12g}")
    lines.extend((".control", "set noaskquit", "op"))
    lines.extend(f"print v({aliases[node]})" for node in nodes)
    lines.extend(("quit", ".endc", ".end", ""))
    return "\n".join(lines)


def _resolve_simulator(simulator_path: str | Path | None) -> Path | None:
    simulator_path = simulator_path or os.environ.get("OHMPATH_NGSPICE")
    if simulator_path is not None:
        candidate = Path(simulator_path).expanduser().resolve()
        return candidate if candidate.is_file() else None
    path_found = shutil.which("ngspice_con.exe") or shutil.which("ngspice")
    candidate = Path(path_found).resolve() if path_found else _DEFAULT_NGSPICE
    return candidate.resolve() if candidate.is_file() else None


def _version(executable: Path) -> str | None:
    try:
        completed = subprocess.run(
            [str(executable), "--version"], capture_output=True, text=True,
            timeout=2, check=False, shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return (completed.stdout + completed.stderr).strip()[:1000] or None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _parse_voltages(output: str, graph: CircuitGraph) -> dict[str, float]:
    physical = {node: "0" if node in graph.ground_nodes else f"n{index}"
                for index, node in enumerate(sorted({n for c in graph.components for n in c.nodes} - set(graph.ground_nodes)), start=1)}
    found: dict[str, float] = {}
    for spice_node, raw_value in _PRINT_LINE.findall(output):
        value = float(raw_value)
        if not (-1e12 < value < 1e12):
            raise ValueError("simulator returned a non-finite or out-of-range voltage")
        matched = next((node for node, alias in physical.items() if alias.casefold() == spice_node.casefold()), None)
        if matched is not None:
            found[matched] = value
    requested = set(physical) - set(graph.ground_nodes)
    if not requested.issubset(found):
        missing = ", ".join(sorted(requested - found.keys()))
        raise ValueError(f"simulator output omitted requested node voltage(s): {missing}")
    return found


def run_operating_point(
    graph: CircuitGraph,
    *,
    simulator_path: str | Path | None = None,
    timeout_s: float = 5.0,
    cancel_event: threading.Event | None = None,
    work_root: Path | None = None,
) -> SimulationResult:
    """Run generated DC OP via a bounded ngspice child process; no imported code executes."""
    if not 0 < timeout_s <= 30:
        raise ValueError("timeout_s must be greater than 0 and no more than 30")
    netlist = generate_netlist(graph)
    netlist_bytes = netlist.encode("ascii")
    executable = _resolve_simulator(simulator_path)
    simulator_hash = _sha256(executable.read_bytes()) if executable else None
    version = _version(executable) if executable else None
    run_id = str(uuid.uuid4())
    if executable is None:
        return SimulationResult(
            simulation_id=run_id, status="failed", provenance="none",
            graph_sha256=graph.graph_sha256, netlist_sha256=_sha256(netlist_bytes),
            simulator_sha256=None, simulator_version=None, node_voltages_v={},
            exit_code=None, duration_s=0.0, stdout="", stderr="",
            netlist=netlist, error="ngspice executable was not found",
        )

    start = time.monotonic()
    stdout = stderr = ""
    exit_code: int | None = None
    status = "failed"
    error: str | None = None
    values: dict[str, float] = {}
    process_started = False
    tmp_parent = str(work_root.resolve()) if work_root else None
    try:
        if work_root:
            work_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ohmpath-spice-", dir=tmp_parent) as run_dir:
            netlist_path = Path(run_dir) / "approved.cir"
            netlist_path.write_bytes(netlist_bytes)
            stdout_path, stderr_path = Path(run_dir) / "stdout.log", Path(run_dir) / "stderr.log"
            with stdout_path.open("wb") as stdout_file, stderr_path.open("wb") as stderr_file:
                process = subprocess.Popen(
                    [str(executable), "-b", str(netlist_path)], cwd=run_dir,
                    stdout=stdout_file, stderr=stderr_file,
                    shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                process_started = True
                deadline = start + timeout_s
                while process.poll() is None:
                    if cancel_event is not None and cancel_event.is_set():
                        process.terminate()
                        try:
                            process.wait(timeout=0.5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        status, error = "cancelled", "simulation cancelled by caller"
                        break
                    if time.monotonic() >= deadline:
                        process.kill()
                        process.wait()
                        status, error = "timed_out", f"simulation exceeded {timeout_s:g} second limit"
                        break
                    if stdout_path.stat().st_size + stderr_path.stat().st_size > 100_000:
                        process.kill()
                        process.wait()
                        status, error = "failed", "ngspice output exceeded the 100 KB limit"
                        break
                    time.sleep(0.02)
                exit_code = process.returncode
            stdout = stdout_path.read_bytes()[:100_000].decode("utf-8", errors="replace")
            stderr = stderr_path.read_bytes()[:100_000].decode("utf-8", errors="replace")
            if error is None:
                output_size = stdout_path.stat().st_size + stderr_path.stat().st_size
                if output_size > 100_000:
                    status, error = "failed", "ngspice output exceeded the 100 KB limit"
                elif exit_code == 0:
                    combined = stdout + "\n" + stderr
                    if _FAILED_ANALYSIS.search(combined):
                        raise ValueError("ngspice reported a convergence or fatal analysis error")
                    values = _parse_voltages(combined, graph)
                    status = "succeeded"
                else:
                    error = f"ngspice exited with status {exit_code}"
    except (OSError, ValueError) as exc:
        error = str(exc)
        status = "failed"
    duration = time.monotonic() - start
    return SimulationResult(
        simulation_id=run_id, status=status, provenance="ngspice_actual" if process_started else "none",
        graph_sha256=graph.graph_sha256, netlist_sha256=_sha256(netlist_bytes),
        simulator_sha256=simulator_hash, simulator_version=version,
        node_voltages_v=values if status == "succeeded" else {}, exit_code=exit_code,
        duration_s=duration, stdout=stdout[:100_000], stderr=stderr[:100_000],
        netlist=netlist, error=error,
    )
