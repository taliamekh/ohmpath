# Assembly and firmware evidence handoff

Status: **bounded local software implementation**. Assembly plans use an already validated circuit graph plus an explicit pin-to-hole map and verified board connectivity groups. Firmware findings parse supplied text only. No board, serial port, build script, configuration, or firmware image was accessed, modified, built, reset, or flashed.

## Assembly API

`build_assembly_plan(graph: CircuitGraph, terminal_holes: Mapping[str, str], *, board_template_id: str, layout_revision: str, hole_groups: Mapping[str, str]) -> AssemblyPlan` validates that every graph terminal has exactly one unique hole, all terminals of a graph net map to one conductive group, and distinct nets do not share a conductive group. The caller must supply the approved mapping; this slice does not infer hole locations, select a breadboard, or infer hidden rail connectivity. Stable plan and step IDs are deterministic for the same graph, layout revision, template, and pin map.

Plans explicitly require disconnected power and separated supply leads. They sequence a power check, one component placement at a time with component/pin/node/hole references, visual inspection, and continuity checks. `graph_equivalent` describes validation of the provided connectivity groups; `physically_verified` is always false at plan generation. `acknowledge_assembly_step(plan, step_id, *, evidence_kind, acknowledged_by, evidence_ref=None, occurred_at=None) -> AssemblyAcknowledgment` stores an explicitly attributed user/evidence report. `reported_done` and `visual_inspection` are not electrical verification. A continuity acknowledgment is limited to the continuity step and does not mutate the plan or claim that an external measurement instrument produced the evidence.

## Firmware evidence API

`parse_firmware_evidence(*, captured_at: datetime | str, firmware_revision: str | None = None, serial_text: str = "", build_output: str = "", configuration_text: str = "") -> FirmwareEvidenceReport` accepts bounded supplied text only (80,000 characters per input, 200,000 total). It retains source/line/time/revision observations and hashes the supplied source bundle. Rule-based candidate hypotheses reference the exact observations that triggered them; recommendations are separate checks, not executable commands. Current rules cover serial/config baud disagreement, repeated boot/reset markers, reported/visible pin configuration issues, and power/brownout log reports. A serial log is self-reported evidence, configuration is not proof of deployed identity, pin assignments cannot be checked without a verified physical map, and power logs are not voltage measurements. Hardware checks are explicitly marked and require user authorization. No serial connection, build, reset, flashing, or shell execution is performed.

## Verification

Command: `.venv/Scripts/python.exe -m pytest services/bench/tests/test_assembly.py services/bench/tests/test_firmware.py -q`

Result: **8 passed in 0.09s**. Coverage includes both curated graphs, deterministic IDs, net connectivity equivalence, split-net/short/occupied-hole rejection, explicit power prerequisites, evidence-labeled acknowledgments, bounded and timestamped input, baud disagreement, reset patterns, pin configuration, brownout suggestions, and command-like supplied text treated only as data.

Broader check: `.venv/Scripts/python.exe -m pytest services/bench/tests -q` => **243 passed in 2.17s**, with one third-party Starlette/httpx deprecation warning from `fastapi.testclient`.

## Files and remaining gates

- `services/bench/src/ohmpath/circuits/assembly.py`
- `services/bench/src/ohmpath/devices/firmware.py`
- `services/bench/tests/test_assembly.py`
- `services/bench/tests/test_firmware.py`
- `docs/development/assembly-firmware-handoff.md`

No canonical schema, dependency, or API contract files were changed. Future work needs a human-reviewed board template/pin map with real geometry, lead-span/clearance rules and occupied-hole state, image/continuity evidence capture, and a physically observed assembly. Firmware support needs user-selected exact MCU/board/pin convention, source/build/deployed identity capture and matched hardware-versus-firmware cases; those are deliberately not inferred here. Proposed commit title: **Add circuit assembly plans and firmware evidence checks**.
