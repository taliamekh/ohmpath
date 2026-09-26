# Circuit diagnosis comparison handoff

Status: **bounded passive DC comparison prototype**. The API runs only internally generated resistor/source DC variants through the existing ngspice adapter. It consumes readings that the caller has already confirmed for the current graph revision. It does not accept model netlists or change session/evidence state.

## API

`diagnose_circuit(graph: CircuitGraph, readings: list[dict], *, work_root: Path) -> dict`

Each reading must have exactly `red_node_id`, `black_node_id`, signed finite `value_v`, and unique `evidence_id`. Endpoints must be distinct nodes in the graph. It returns `hypotheses` shaped for the UI (`id`, `title`, `status`, `score`, `predictions`) with supporting/contradicting evidence IDs, per-reading comparisons, assumptions, and the simulated probe-pair basis for predictions. `score` is a normalized-residual ranking aid, **not a probability**. The explicit `unknown-or-combined` candidate carries no invented predictions.

`next_test` is either a DC-voltage test between graph nodes or `null`. It ranks only actual-ngspice predictions from still-consistent modeled candidates, then chooses a probe pair whose predictions differ by more than twice the provisional comparison band. The low-B divider case (`B–GND = 0.275 V`) retains both `R1-high` and `R2-high` and selects `A–GND`; the predicted A values are about 0.55 V and 3.025 V respectively.

The `simulations` array contains each actual `SimulationResult` with its variant and meter probe pair. Failed/timed-out runs remain failures and have no voltage table; diagnosis does not substitute zero, analytic values, or mock outputs. If ngspice is missing or a run fails, hypotheses remain unresolved and `next_test` is not based on fabricated values. Simulation records are already separate from hypotheses so the caller can ledger them as actual simulator evidence.

## Bounds and limitations

- Accepts at most six resistors, one independent DC source, 12 readings, 16 unique simulation probe pairs, and a 15-second total scheduling budget (three seconds reserved for ngspice version probing and cleanup). No cancellation input is exposed by this API; run time is bounded by the existing per-process timeout plus the analysis scheduler bound.
- Every reading/test is modeled with an ideal 10 MΩ resistor across the probes. It is an explicit assumption, not a characterization of the physical meter.
- A high-path scenario uses `max(10× nominal, 100 kΩ)`, so the loaded-divider milliohm jumper fault includes the intended 100 kΩ resistive-path surrogate. It is not proof that the resistor itself failed. Open is represented by 1 TΩ; bypass by 1 µΩ. These are near-open/near-short proxies, not ideal fault models.
- The comparison band is `max(50 mV, 10% of |measured|, 10% of |predicted|)`. It is deliberately conservative and provisional, not a validated statistical interval. Component tolerances, supply uncertainty, meter accuracy/resolution, and repeatability are not modeled.
- A matching simulation only makes a case a candidate. It cannot distinguish component failure from contact, wiring, measurement setup or model error. Physical diagnosis still needs the proposed follow-up measurement and/or continuity evidence.

No models or directives are imported; generated graphs go only through the existing fixed netlist generator. This profile does not cover active devices, arbitrary topologies with multiple independent sources, transient analysis, firmware, or combined fault enumeration. No hardware was accessed.

## Verification

Command: `.venv/Scripts/python.exe -m pytest services/bench/tests/test_diagnosis.py -q`

Result: **10 passed in 11.90s** in the configured environment with ngspice available. Tests execute actual ngspice for the ambiguous B case, signed red/black comparisons, the loaded-divider 100 kΩ high-path surrogate, and the explicit unknown case; they also verify failure output cannot become zeros, malformed readings are rejected before simulation, and the six-resistor bound is enforced. The failure-path test injects a failed simulator result locally; it does not describe a physical failure or claim an actual ngspice crash occurred.

Changed paths:

- `services/bench/src/ohmpath/circuits/diagnosis.py`
- `services/bench/tests/test_diagnosis.py`
- `docs/development/diagnosis-handoff.md`

No shared contract/schema, dependency, or API manifest was changed. Proposed commit title: **Compare circuit faults with bounded ngspice runs**.
