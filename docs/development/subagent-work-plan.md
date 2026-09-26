# Subagent work plan

The user requested subagents. Use them for bounded development tasks and independent review, not as multiple simultaneous runtime circuit investigators. One coordinator plus at most three active workers fits the current environment. Assign the next ready task when a worker finishes; do not create new user-visible tasks for ordinary subtasks.

## Coordinator responsibilities

The coordinator owns requirements, architecture, shared contracts, dependency manifests/lockfiles, integration tests, Git history, and user communication. It resolves disagreements and reviews all completed work. It does not claim an integration is verified because each worker tested an isolated mock.

No worker edits shared configuration, installs dependencies, commits, pushes, spends money, changes account settings, flashes boards, or actuates hardware without a specific coordinated authorization. User physical tests remain separate handoffs. Preserve existing files and other workers' changes.

## Work packages and ownership

These paths are the planned code layout. They do not imply code exists yet.

| Worker role | Main responsibility | Exclusive implementation area when assigned | Required handoff |
| --- | --- | --- | --- |
| Circuit tools | KiCad graph import, model registry, ngspice analysis | `services/bench/src/ohmpath/circuits/` and assigned circuit tests/fixtures | Actual simulator outputs, model assumptions, invalid-import cases |
| Investigator | Evidence-backed hypotheses and next-test proposals | `services/bench/src/ohmpath/diagnostics/` and assigned diagnosis tests | Grounding tests, unknown/contradictory cases, no direct state mutation |
| AI connection | Subscription adapter and narrow MCP bridge | `services/bench/src/ohmpath/ai/` and protocol fixtures | Capability/permission proof, cancellation/limits, actual model evidence |
| Camera and geometry | Capture, calibration, targets, meter candidates | `services/bench/src/ohmpath/vision/` and assigned image fixtures | Transform/latency tests, uncertainty and stale-view behavior |
| Voice | Local transcription, parsing, speech output | `services/bench/src/ohmpath/voice/` and assigned audio fixtures | Signed-unit corpus, confirmation and interruption tests, measured latency |
| Pi and aiming | Camera service, bounded yaw/pitch, crosshair loop | `services/pi/` and explicitly assigned Pi adapter files | Dry-run/controller tests, command/reconnect handling, physical test instructions |
| Interface and companion | Bench UI, overlays, character window | `apps/desktop/src/renderer/` and assigned frontend tests/assets | Usability/state tests, asset provenance, no backend authority duplication |
| Independent reviewer | Cross-layer safety and acceptance | Read-only by default; assigned tests if needed | Concrete defects, evidence, and pass/fail checklist rather than general reassurance |

Roles are reusable task assignments, not eight agents running at once. Circuit assembly and firmware work are later tasks within the relevant role; separate them only after explicit ownership handoff.

## Parallel waves

### Wave one: bootstrap and prove the integration

Coordinator establishes the smallest runnable foundation and freezes the first contracts. Then dispatch:

- AI connection worker: subscription/tool boundary proof.
- Circuit tools worker: passive fixture simulator adapter and KiCad import.
- Camera worker: camera adapters and geometry replay with laser disconnected.

Coordinator implements the authoritative session shell and initial UI integration, reviews interfaces, and runs cross-service tests. No model-generated device actions are enabled.

### Wave two: complete the measurable user loop

Once foundation, model-tool proof, and circuit outputs are usable:

- Investigator worker: adaptive testing, confirmation and revision-aware recommendations.
- Voice worker: microphone, local transcription, readback and approved TTS.
- Pi/aiming worker: motor-disabled simulation, then bounded motor-only crosshair convergence after hardware review.

Coordinator integrates overlays, event cancellation, budget/status controls, and the actual typed/voice diagnostic session. Camera worker hands off ownership before the Pi worker changes any shared vision code. Safety service edits remain coordinated and independently reviewed.

### Wave three: broaden usefulness and finish presentation

- Circuit worker: verified assembly/reassembly graph and active-circuit support.
- Investigator/device worker: firmware evidence and hardware-versus-code cases.
- Interface worker: animated Frieren, companion window, guide registry; voice owner separately hands off any hands-free changes.

Coordinator manages physical safety validation and end-to-end review. Do not overload one wave with extra simultaneous workers; finish or pause a bounded task before reassigning its slot. Missing physical parts should not block independent local software tasks.

### Wave four: adversarial acceptance and delivery

Assign workers to review a different area than the one they authored: electrical/unit correctness, physical/revision safety, and voice/UI/recovery. Fix failures in small owned changes. The coordinator packages the result, records remaining limitations and demonstrates the actual loop with the user.

## Task assignment template

Every dispatched task should state:

1. Outcome and related checklist milestone.
2. Exact writable paths and read-only dependencies.
3. Required schema version and accepted input/output examples.
4. Tests and artifact evidence expected.
5. Explicit forbidden actions, including spending and physical operation.
6. Dependencies, known unknowns, and the point at which to report a blocker.
7. Handoff contents: changed files, actual test commands/results, missing verification, risks, and proposed human-readable commit title.

Example bounded assignment: "Implement measurement candidate parsing and explicit confirmation for the existing request contract. Own only the voice parser and its tests. Cover negative values, decimal words, milli/micro prefixes, OL, corrections, and stale confirmation. Do not modify the evidence store, schemas, dependencies, or device controls. Return the test results and remaining ambiguities."

## Integration and review gates

Before dispatch, check working-tree state and avoid overlapping edits. In this environment workers share the same filesystem; a branch name alone does not isolate their changes. Use disjoint paths. Introduce separate worktrees only when their benefit exceeds coordination cost and no uncommitted user work is lost.

The coordinator reviews the actual diff, runs contract and affected integration tests, then commits only explicit paths. Reject work that changes a schema without agreement, hides a failed service with mock output, weakens a safety check, or silently introduces paid usage.

A worker reporting "done" means its bounded task is ready for review, not that a milestone is complete. The checklist changes only after its acceptance evidence is recorded. Keep one active runtime diagnostic turn to limit conflicting advice and cost; internal local simulations may run in bounded parallel jobs.

## Planning work completed in this turn

Three planning subagents authored the circuit-diagnosis, hardware/vision, and voice/interaction design documents in separate files. The coordinator authored requirements, the integrated specification, contracts, build sequence, verification plan, and repository policy. A follow-up cross-document review reconciles terminology and interfaces. No application workers have been dispatched to implement this plan yet.
