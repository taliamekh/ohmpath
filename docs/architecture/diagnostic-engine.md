# Diagnostic engine and circuit evidence

Status: implementation plan, not a claim of working application behavior. Updated September 26, 2026. Ohm Path is the current project name; existing Benchmate material is historical design evidence.

## What the engine must accomplish

Ohm Path should explain what might be wrong, choose a useful next test, interpret the result, and help the person repair or rebuild their circuit. It must consider wiring, supply, components, measurement mistakes, configuration, and firmware. It may reach a provisional diagnosis before it can prove a root cause, but it must identify what would confirm or contradict that diagnosis.

The language model supplies reasoning and explanation. Local software owns evidence, calculations, simulation, allowed tests, state changes, and safety checks. A strong model with these tools is the chosen approach; training a special circuit model is not a prerequisite. Simulation and a plausible explanation are not substitutes for physical measurements.

The two passive fixtures below are the first reproducible regression suite, not the product's capability ceiling. Add circuit families through explicit models, supported analyses, board mappings, and appropriate instrument evidence. An unfamiliar circuit can still receive identification, schematic review, and test-planning help while Ohm Path clearly states which claims it cannot yet verify.

## Four separate representations

| Representation | Contents | What it does not prove |
| --- | --- | --- |
| Intended design | Imported schematic, component values and tolerances, pin definitions, named nets, power limits, desired behavior | That the physical board matches it |
| Observed assembly | Camera observations, person-confirmed hole placements, continuity-confirmed connections, component markings, uncertainty and occlusion | Conductivity under load or hidden internal connections from a photograph alone |
| Measured behavior | Confirmed signed readings, units, meter mode/range, probe endpoints, source, time, uncertainty and operating condition | A unique cause when multiple faults predict the same behavior |
| Firmware and configuration | Exact board identity, source snapshot, build settings, pin assignments, binary identity if known, logs and observed runtime state | That the connected device is actually running the inspected source |

Implement an immutable evidence ledger in SQLite with derived current-state views. Store the original evidence and provenance; never silently rewrite a reading after a correction. A correction supersedes an earlier item. Every conclusion references the evidence and simulation records that support it, plus assumptions and unresolved contradictions.

Use `circuit_revision` for the accepted electrical/assembly state; distinguish intended-design and observed-layout hashes inside that revision. Use `firmware_revision` for the declared firmware/configuration state. Record unknown deployed firmware as unknown, not as the latest source. `calibration_revision` identifies the current camera/physical mapping. Revision changes invalidate affected pending tests and recommendations. Historical measurements remain visible but are not automatically treated as fresh measurements of the changed circuit.

## Local components and responsibilities

| Component | Responsibility and boundary |
| --- | --- |
| Circuit importer | Runs fixed KiCad export/check operations; preserves source files; creates an import report and normalized graph |
| Model registry | Stores component models, pin mapping, source/license, hashes, supported analysis types, and known limitations |
| Simulation adapter | Generates validated analysis variants, runs ngspice, returns numeric data and actual logs; never invents a successful result |
| Evidence service | Validates and stores observations, confirmations, measurements, firmware evidence, and revision changes |
| Hypothesis manager | Maintains competing explanations and their evidence, contradictions, and required confirmation tests |
| Test planner | Produces admissible tests, estimated discriminating value, prerequisites, and semantic target IDs |
| Safety validator | Rejects instructions outside the current circuit/instrument profile or with unmet prerequisites |
| Assembly planner | Converts a validated net graph into a checked breadboard layout and sequenced human instructions |
| Report builder | Produces a repair history with calculated, simulated, measured, and unresolved claims distinctly labeled |

Implement these as Python modules behind FastAPI/Pydantic, not separate services at first. Expose narrow capabilities to the subscription-backed Codex adapter through local MCP tools. UI and voice consume the same validated action objects. Neither a character persona nor a spoken paraphrase can change the electrical meaning of an instruction.

## KiCad and ngspice integration

KiCad's documented CLI supports schematic electrical-rule checks and exports including XML/SPICE netlists and SVG. Use XML for connectivity, SPICE for simulation preparation, and SVG for the schematic view. Preserve hierarchical identity rather than relying only on displayed reference names. A successful export is not a successful simulation. [KiCad 10 CLI](https://docs.kicad.org/10.0/en/cli/cli.html)

The import pipeline is:

1. Copy an explicitly selected project snapshot into a session import area; hash its schematic and approved dependencies. Do not overwrite the user's KiCad project.
2. Run ERC and export graph/netlist/SVG with a configured executable and argument arrays. Capture versions, exit codes, reports, and warnings. An ERC warning requires classification, not automatic suppression; ERC cannot prove the physical board is correct.
3. Normalize component identity, pin-to-net mappings, values, units, power domains and ground references. Compare the source graph with the proposed simulation mapping. Show missing/unsupported models and ambiguous pin ordering for review.
4. Require a supported model for each simulated element. Validate model pin order, operating conditions and supported analyses; a numerically converged result can still come from the wrong model. KiCad documents simulation model configuration and pin assignments. [KiCad simulator documentation](https://docs.kicad.org/10.0/en/eeschema/eeschema.html#simulator)
5. Generate an approved analysis in a dedicated run directory. Start with DC operating point and bounded parameter sweeps; then add transient and AC analysis when required by a circuit family and verified against reference cases.
6. Run ngspice as a hidden, bounded child process; collect raw numeric output, stderr/stdout, convergence status and duration. Parse requested quantities only after checking their presence and finiteness. Treat timeouts, convergence problems, unsupported syntax and missing vectors as failures, not zero volts.
7. Cache by normalized netlist, model hashes, tool version, analysis settings, physical operating conditions and meter model. Return a content-addressed simulation record. A changed component, supply, model, or meter placement changes the cache key.

ngspice supports operating-point/transient analyses and scripted analysis control; its control language also includes file-oriented operations. Ohm Path will generate its own limited commands rather than accept arbitrary imported control blocks. The shared-library API remains a later optimization, not a prerequisite for integrated simulation. [ngspice control language](https://ngspice.sourceforge.io/ngspice-control-language-tutorial.html), [ngspice shared library](https://ngspice.sourceforge.io/shared.html)

### Process and import security

Only the adapter chooses executables, analysis templates and output locations. Model-supplied strings must not become shell commands. Resolve approved dependency paths canonically inside a dedicated model/import area; reject traversal, network paths, unexpected links/reparse points, shell/control directives and unsupported includes. Disable external entities in XML parsing. Display exported SVG through a sanitized, non-scriptable image surface rather than injecting it as trusted page markup.

An allowlist parser is not a complete sandbox. Initially accept curated fixture/model packages and explicitly reviewed imports; unknown vendor model syntax is rejected for simulation until its compatibility and confinement are reviewed. Add restricted-process isolation before advertising arbitrary untrusted netlist execution. Apply CPU/time/output-size limits and cancellation to every run, and terminate only that run's process tree.

## Measurements and trustworthy spoken results

The existing HT118A is treated as a visual/manual meter, not a digitally connected instrument. A spoken reading, typed value, or camera OCR result follows the same confirmation pipeline. Later digital instruments can implement the same measurement contract without changing the diagnostic engine.

1. Open exactly one active `measurement_request` with quantity, meter mode, power prerequisites, red and black endpoints, expected dimensional unit, accepted revisions and expiry.
2. Instruct the person using both probe endpoints. For a differential voltage, never silently reuse the earlier ground reference.
3. Parse a final transcript or stable OCR candidate into a provisional reading. Preserve original text/image reference, sign, decimal, prefix and display state. `OL`, unstable, inaccessible and unknown are valid nonnumeric outcomes; their meaning depends on meter mode.
4. Read back the interpretation: “I heard positive two hundred seventy-five millivolts, which is 0.275 volts, with red at B and black at ground. Is that correct?” Show the same interpretation on screen.
5. Accept explicit confirmation only for that request/candidate, its single-use confirmation ID, unchanged revisions and matching `measurement_context_hash`. Changing power/load conditions, meter mode/range or probe placement cancels/reissues the request even if the graph revision is unchanged. A partial transcript, bare number while no test is active, stale “yes,” or voice detected from Ohm Path's own speaker must not become a confirmed measurement.
6. Validate range, units, mode and plausibility. An unexpected but confirmed value is evidence; do not replace it with the expected value. If it exceeds the validated circuit/instrument profile, stop the test and request safe setup review.
7. Commit the confirmed reading and recompute comparisons. If the user corrects it, retain the earlier record as superseded and retract conclusions that depended on it.

For repeated acquisition within one unchanged, explicitly confirmed meter/probe setup, an opt-in continuous mode may display a clearly provisional trace. Promote a stable value to diagnostic evidence only through the same confirmation policy until measured OCR/ASR performance justifies a separately reviewed policy. “Live readings” must not mean unreviewed digits silently changing a diagnosis.

No current-jack measurement is part of the initial supported meter workflow. Begin with voltage and de-energized resistance/continuity, adding additional modes only with a validated instrument procedure. Resistance/continuity requires power disconnected, stored energy addressed, appropriate residual-voltage verification and path isolation; an app checkbox is not electrical isolation. [Fluke resistance procedure](https://www.fluke.com/en-us/learn/blog/digital-multimeters/how-to-measure-resistance), [Fluke continuity procedure](https://www.fluke.com/en-us/learn/blog/digital-multimeters/how-to-test-for-continuity)

## Diagnostic loop and choosing the next test

Each turn receives a compact evidence snapshot, the intended behavior, current discrepancies and admissible tools. It does not need the full camera stream or the entire session transcript. Board movement, topology edits, power-mode changes and new confirmed readings trigger fresh analysis; cosmetic video motion does not.

The planner follows this loop:

1. Verify the circuit identity, current revisions, reference node, supply conditions and measurement reliability.
2. Generate a small set of explanations spanning wiring, supply, component, instrument and firmware causes when relevant. Keep an explicit unknown/combined-fault explanation.
3. Obtain actual simulated predictions or clearly labeled analytic bounds for hypotheses that have valid models. Mark unsimulatable hypotheses as such; do not manufacture predictions for them.
4. Compare each prediction with measurement intervals, not exact nominal numbers. Include component tolerance, measured-supply uncertainty, meter accuracy/resolution/loading and observed repeatability. Nonlinear cases need validated sweeps or another bounded method; corner checking alone is not universally sufficient.
5. Rank hypotheses by contradiction severity, amount and independence of supporting evidence, and model validity. Display “consistent,” “weakened,” “contradicted,” or “unresolved,” with reasons. Do not present a numeric probability unless it comes from a separately calibrated statistical model.
6. Generate possible tests and discard those with unmet safety prerequisites, inaccessible nodes, unsupported instrument capabilities or stale mappings.
7. Among the safe tests, prefer a test that separates leading explanations with clear predicted bands, minimizes probe/power changes and gives an interpretable result. Use a deterministic score based on separable candidate pairs, test effort and uncertainty; call it a selection score, not a probability.
8. Explain why this test matters, what outcomes would imply, and when to stop. Execute no physical repair on the person's behalf. Await a confirmed result, then repeat.

Example: in the three-resistor network, a low B reading near 0.275 V fits both a high-resistance R1 path and a high-resistance R2 path. An A measurement separates those cases. Even after localization, an isolated resistor/path test is needed to distinguish a wrong resistor from a poor contact. The engine should say “the A–B path has excess resistance” until evidence supports a more specific cause.

The model may propose a novel explanation outside the curated library. Record it with its assumptions and supporting evidence, then convert its suggested test into the same validated test format. If no model or admissible test exists, ask for a named missing item such as the exact part number, a clearer connection image, a continuity check, a serial trace or an oscilloscope capture. Do not force every case into a single-fault answer.

## Hardware versus firmware

For a powered sensor or microcontroller circuit, inspect these layers without assuming that the first plausible issue is the only one:

| Layer | Evidence to collect | Example distinction |
| --- | --- | --- |
| Identity and intended behavior | Exact board/module revision, datasheet, source/configuration, pinout and desired observable behavior | Wrong pin-number convention versus faulty part |
| Electrical prerequisites | Voltage at the device under its normal load, common reference, reset/enable state and validated connectivity | Brownout, missing ground or disconnected signal versus code logic |
| Build/deployment | Compiler diagnostics, board target, source/build hash, available binary/build identifier | Correct source on laptop versus older firmware still running |
| Runtime | Read-only serial logs, boot/reset events, configured baud rate, timestamps, reported state | Reset loop, initialization failure or wrong configuration |
| Interface behavior | Measured static levels and, when needed, logic-analyzer/oscilloscope/protocol traces | Pin stuck high versus fast waveform that a multimeter averages |
| Controlled comparison | Explicitly approved configuration change or known-good test firmware and retest | Firmware-specific failure versus physical defect |

Static source review can identify a likely code defect but cannot certify the deployed program. Serial messages are self-reported observations, not direct proof of the electrical signal. Store both when they disagree. A DC meter cannot resolve arbitrary timing/protocol faults; Ohm Path must name the missing instrument rather than conclude that a component is broken.

The initial firmware connector is read-only log capture and source/configuration inspection. Opening a serial port can reset some boards through control lines; the adapter must document its board-specific behavior and obtain approval before an action that can disturb operation. Compiling supplied projects may run build scripts, so use an explicit reviewed build workflow, not an unrestricted automatic command.

Flashing, resetting, changing a powered device's configuration, or installing drivers requires a separate explicit user-approved action and an identified device. Record before/after firmware revisions and invalidate affected evidence. The model cannot authorize its own flash operation. A test passes only when the intended physical function is checked again, not merely because a build succeeded.

## Assembly and reassembly guidance

Support “help me put this together” as a first-class mode using the same intended graph, not free-form invented hole numbers.

The board model contains a `board_template_id`, measured geometry, hole IDs such as `main_board:left:a:5`, internal connectivity groups, rail splits, center gap, orientation, occupied holes, component lead geometry and polarity/pin labels. Hidden connectivity is a verified template property or a confirmed continuity observation; color stripes are not sufficient evidence of a continuous rail.

The assembly planner will:

1. Obtain the intended circuit and identify exact polarized/active parts and pinouts. Unidentified packages require clarification before pin-specific instructions.
2. Select a verified breadboard template and orientation. Confirm split rails and any uncertain internal connections with power off.
3. Generate placements constrained by electrical connectivity, unique hole occupancy, lead span, center-gap requirements, polarity, physical clearance and accessible probe contacts.
4. Reconstruct the resulting net graph from proposed hole placements and compare it with the intended graph. Reject missing links, unintended shorts and incorrect pin mappings before presenting the plan.
5. Sequence assembly with power disconnected: place/identify components, connect reference and power paths, add signal links, then perform inspection and relevant continuity checks. Keep disconnected power leads visibly separated until the power-on gate.
6. Present one action at a time with component ID, lead/pin identity, exact hole endpoints and the reason for the connection. Use the same semantic targets for screen highlights and any allowed physical pointing.
7. Let the user report “done,” ask a question, undo a step, or use different holes. A verbal “done” records completion, not automatic electrical verification. Recheck the graph after every accepted layout change.
8. Compare fresh images and confirmations with the plan, flag uncertain observations, then run the circuit's pre-power checks and first measured functional test.

For reassembly, retain an explicitly saved, verified layout and version it separately from later observations. Highlight the difference between intended and current layout; do not silently erase the evidence of the fault. Photograph recognition assists mapping but does not prove that a lead is electrically seated.

## Proposed shared contracts

The [shared contracts](contracts.md) are canonical. Use their project-wide envelope, including `schema_version`, `session_id`, `event_id`, `event_type`, `source`, `sequence`, `occurred_at`, `received_at`, `circuit_revision`, `firmware_revision`, `calibration_revision`, `correlation_id`, and `payload`. Nullable revision fields follow the canonical unknown/not-applicable policy. The backend assigns sequence numbers and records duplicate event IDs idempotently; clients do not infer freshness from wall-clock time alone. Corrections use `supersedes_event_id` and preserve earlier evidence.

| Object | Required domain fields beyond the envelope |
| --- | --- |
| `circuit_snapshot` | `circuit_id`, intended/observed graph hashes, named components/pins/nets, operating profile, unresolved mappings |
| `evidence_record` | `evidence_id`, kind, origin, raw artifact reference/hash, observation time, confirmation status, uncertainty, superseded evidence ID if any |
| `measurement_request` | `request_id`, quantity, mode, red/black `node_id` and optional `contact_id`, canonical target IDs, instrument profile, prerequisites, expected unit, expiry and requested evidence |
| `measurement_candidate` | `request_id`, `candidate_id`, raw transcript/OCR/manual text, parsed signed value or nonnumeric state, unit, display range/mode, source evidence IDs |
| `measurement_confirmation` | `request_id`, `candidate_id`, single-use `confirmation_id`, `measurement_context_hash`, explicit confirmation evidence, interpreted value/unit/endpoints shown to the user, accepted revision snapshot |
| `simulation_result` | `simulation_id`, graph/model/tool hashes, analysis, parameters, convergence status, numeric values with units, uncertainty method, actual log reference |
| `hypothesis` | Hypothesis ID, named suspect component/path/software condition, explanation, supporting/contradicting evidence IDs, assumptions, qualitative status, confirmation test |
| `test_proposal` | Test ID, hypothesis IDs, instructions, semantic target IDs, prerequisites, predicted outcomes, required capability, reason selected, review status |
| `assembly_step` | Layout revision, step ID, component/pin identities, from/to hole IDs, intended nets, power prerequisites, verification method and completion state |

Do not expose raw servo angles or GPIO writes in a diagnostic result. A test names electrical nodes/contacts; the visual/pointer subsystem resolves approved targets under its own calibration and safety rules. A calibration failure may disable physical pointing while leaving a valid, clearly labeled electrical calculation available.

Use the top-level adapter's canonical MCP names: `get_session_evidence`, `get_circuit_graph`, `simulate_variant`, and `propose_test`. Component-model lookup, measurement comparison, assembly proposals and hypothesis recording may extend that narrow interface through coordinator-reviewed schema changes; they are not separate competing API names. Proposals are not accepted measurements or physical commands. Confirmation and actuator authorization belong to local application state and explicit user interaction, not to a model-writable confirmation flag.

## Reproducible baseline fixtures

The following values are ideal calculations at exactly 3.300 V, not measured results. The build must create versioned KiCad/normalized-graph fixtures, ngspice run evidence, and separate physical records before claiming validation.

### Three-resistor diagnostic network

Connect supply → R1 → A → R2 → B → R3 → ground. Healthy R1, R2 and R3 are each 10 kΩ. For each measurement, black is ground unless the test explicitly says otherwise.

| Controlled state | Ideal A | Ideal B | Required diagnostic behavior |
| --- | --- | --- | --- |
| Healthy | 2.200 V | 1.100 V | Verify both nodes against bands based on actual supply |
| R1 changed to 100 kΩ | 0.550 V | 0.275 V | Low B alone must not uniquely identify R1 |
| R2 changed to 100 kΩ | 3.025 V | 0.275 V | Choose A to distinguish it from the preceding case |
| R3 open | 3.300 V | 3.300 V | Include meter loading; confirm lower path before blaming R3 |
| R2 open | 3.300 V | 0.000 V | Localize middle path, then distinguish part/contact |
| R1 open, supply present | 0.000 V | 0.000 V | Distinguish from missing supply |
| R2 bypassed | 1.650 V | 1.650 V | Check unintended A–B connection before blaming an internal short |

Proposed placement template, requiring physical verification: supply at left row 5, A at row 10, B at row 15, ground at row 20; R1 e5–e10, R2 d10–d15, R3 e15–e20; supply a5, ground a20; accessible test contacts b5/b10/b15/b20. This assumes a–e in each row are connected and numbered rows are separate. Verify that actual board layout; do not blindly apply these coordinates to another breadboard.

### Jumper and load network

Connect supply → 1 kΩ current-limiting resistor → P → removable jumper → Q → 10 kΩ load → ground. Keep the current-limiting resistor in every controlled state; change faults with power removed.

| Controlled state | Ideal P | Ideal Q | Required diagnostic behavior |
| --- | --- | --- | --- |
| Healthy jumper | 3.000 V | 3.000 V | Verify the functioning path under load |
| Jumper removed | 3.300 V | 0.000 V | Localize P–Q; isolate wire to distinguish wire/contact/row |
| Jumper replaced by 100 kΩ | 3.270 V | 0.297 V | Disclose this as a controlled resistive-path surrogate |
| Load open | 3.300 V | 3.300 V | Distinguish load path from supply and meter-loading effects |
| Load bypassed, limit retained | 0.000 V | 0.000 V | Confirm supply and load path without introducing a live short |

At 3.300 V the ideal bypassed-load current is 3.3 mA and limiting-resistor dissipation is 10.89 mW. These calculations apply only to this identified fixture and do not authorize arbitrary short-circuit experiments. A good isolated wire followed by a bad assembled connection must redirect the diagnosis to contact/placement, not trigger an unnecessary replacement.

## Verification gates and growth

Before wiring the model into a live bench loop, test deterministic parsing, unit conversion, duplicate delivery, cancellation, state revision and simulation failures with recorded inputs. Then complete these gates:

1. **Simulation gate:** calculate the passive reference values independently, run actual ngspice cases and tolerance/meter-loading variants, and compare numeric outputs. Preserve input/output evidence.
2. **Ambiguity gate:** give only low B in the two high-resistance cases. Require an additional discriminating test; fail any answer claiming that B alone proves R1 or R2.
3. **Measurement gate:** test “minus 275 millivolts,” “point two seven five volts,” wrong unit, `OL`, instability, stale “yes,” switched probes and correction after confirmation. No unconfirmed or stale value may become current evidence.
4. **Physical gate:** build safe known fixtures; record real meter results and uncertainty; use builder-hidden fault labels and a separate operator. Keep calculated, simulated and physically verified status separate.
5. **Unknown/multiple-fault gate:** add supply-off, two faults, misleading part markings, wrong template and occluded connections. Require either useful safe localization or a named next evidence request, not forced certainty.
6. **Assembly gate:** reconstruct the intended net graph from generated hole placements; test split rails, polarity, occupied holes, shifted rows and changed board orientation. Physically audit a complete guided assembly.
7. **Firmware gate:** select an exact supported MCU/module, capture a reproducible source/build/runtime baseline, and inject a known pin/configuration or logic error separately from a physical wiring error. Verify that the diagnosis differentiates them with evidence; no device flashing is implicit.
8. **Expansion gate:** add an analog/active circuit or transient behavior with a documented model and suitable measuring equipment. Publish support by circuit family and evidence type, not a blanket claim that every circuit is understood.

Report correctness of the chosen next test, unsafe-request rejection, evidence citation, calibrated ambiguity, repair verification, number of measurements and end-to-end latency separately. A small successful demo is not a universal accuracy claim. A failed model/tool run remains visible and cannot silently become a successful tutorial example.

## First implementation decisions

Start with the evidence/contracts and simulator boundary, then connect model reasoning to those verified tools. Add manual confirmed measurements before OCR automation, without delaying the shared voice measurement contract. Integrate firmware inspection and assembly planning as dedicated capabilities rather than hiding them inside a generic chat prompt.

The important unknowns are real board/component identities, actual meter operating characteristics, supported device/firmware targets, the quality of camera mapping and speech-number transcription, and measured reasoning/tool latency. Resolve each through a named verification gate; no research-only plan can remove the need to test the real setup.
