# Circuit tools handoff

Status: bounded circuit-tools slice implemented; ready for coordinator review. No physical fixture was built or measured.

## Public API

- `load_fixture(name: str) -> CircuitGraph`: accepts only `divider` and `loaded-divider`.
- `run_operating_point(graph: CircuitGraph, *, simulator_path: str | Path | None = None, timeout_s: float = 5.0, cancel_event: threading.Event | None = None, work_root: Path | None = None) -> SimulationResult`: generates and runs the approved resistor/DC-source operating-point netlist. Result provenance is `ngspice_actual`; failures, cancellation, and timeout return no successful numeric values.
- `export_kicad_xml(schematic_path: Path, *, source_root: Path, kicad_cli_path: str | Path | None = None, timeout_s: float = 15.0) -> bytes`: invokes only `kicad-cli sch export netlist --format kicadxml --output <temporary file> <approved schematic>` with `shell=False`.
- `import_kicad_xml(xml: str | bytes | Path, *, source_root: Path | None = None) -> CircuitGraph`: accepts a bounded, entity-safe XML subset with resistor and independent DC source pin maps; executable directives, models, missing grounds/models/pins, unsupported values, and paths outside an approved root are rejected.

The graph registry supports passive resistors and independent DC voltage sources with explicit SI values and fixed pin models. It does not accept imported SPICE directives or arbitrary model files. Simulation results preserve graph/netlist/tool hashes, requested voltages, exit status, actual stdout/stderr, duration, and simulator version. Output is capped at 100 KB and each child process has a timeout; windows are hidden where supported.

## Verification

Command: `.venv/Scripts/python.exe -m pytest services/bench/tests/test_circuits.py -q`

Result: **14 passed in 0.30s**, including actual ngspice runs and hand-calculated reference comparisons. The tests cover invalid values/ground/model/pins, unknown fixture names, malformed and malicious XML/entity content, path traversal/out-of-root paths, and pre-cancelled simulation.

Actual ngspice 47 results from the installed executable:

| Fixture | Actual ngspice nodes | Independent ideal reference | Exit |
| --- | --- | --- | --- |
| `divider` | A = 2.200000 V; B = 1.100000 V; supply = 3.300000 V | A = 2.2 V; B = 1.1 V | 0 |
| `loaded-divider` | P = 3.000000 V; Q = 3.000000 V; supply = 3.300000 V | P = 3.0 V; Q = 3.0 V | 0 |

Both runs returned `status=succeeded`, provenance `ngspice_actual`, tool SHA-256 `22d5cae2bd32b2e39157a8d27bf457122f68285b72a9ebefdf41551b628233ab`. Netlist SHA-256 values were `049c2649fefe4e2f320c89c6eade4e868657bfcf33ecaf5fa4cc09dd84eb89b4` (`divider`) and `1f5bca8ae5c691a4c0c3c31f215e8e38571047fe88b03bbde22a8b9d64ecb0ee` (`loaded-divider`).

KiCad CLI 10.0.6 is installed and its XML export argument syntax was confirmed from `kicad-cli sch export netlist --help`. No `.kicad_sch` file exists in the repository, so this slice did not execute an actual schematic export. XML normalization/security tests ran against controlled XML strings; coordinator integration should supply a reviewed schematic for the real export check.

No dependencies were added. Shared schema version 1.0.0 was not changed. No physical measurement, hardware actuation, or laser/motor operation was performed.

## Changed paths

- `services/bench/src/ohmpath/circuits/__init__.py`
- `services/bench/src/ohmpath/circuits/models.py`
- `services/bench/src/ohmpath/circuits/simulation.py`
- `services/bench/src/ohmpath/circuits/kicad.py`
- `services/bench/tests/test_circuits.py`
- `fixtures/circuits/divider.json`
- `fixtures/circuits/loaded-divider.json`
- `docs/development/circuit-tools-handoff.md`

Proposed commit title: **Add validated circuit simulation and KiCad import tools**
