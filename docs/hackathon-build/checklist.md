# Ohm Path build checklist

Status: **planning complete; every implementation milestone below is still unchecked**. This is a dependency-driven plan, not a promise that a complete advanced hardware product fits a fixed number of hackathon hours. Confirm the remaining event time before assigning estimates. Break each milestone into a first verifiable slice before dispatching it; several milestones will take multiple work sessions.

Use the [subagent plan](../development/subagent-work-plan.md) for parallel ownership. The coordinator reviews and commits one meaningful change at a time using [plain-English titles](../../CONTRIBUTING.md). Do not mark a package complete when only one child task passes.

## Foundation and highest-risk proof

- [ ] **1. Establish the application foundation and shared contracts**

  Spec ref: [Stack, desktop lifecycle, file structure](spec.md).
  What to build: Record installed versions; create the desktop and bench-service skeleton; define canonical schemas, generated bindings, event ledger, health checks, mock adapters, and test commands. Verify actual device inventory and software prerequisites without energizing the turret. Add repeatable setup and CI for tests that need no secrets or hardware.
  Acceptance: A fresh development checkout starts a named Ohm Path window and local service, creates/resumes a mock session, and validates a round-trip event. No credentials or private recordings enter Git.
  Verify: Schema/unit tests, startup/shutdown and renderer-restart tests, dependency lockfiles, clean-install instructions, and a reviewed staged diff. Record uninstalled dependencies honestly.

- [ ] **2. Prove the subscription-backed investigator and permission boundary**

  Spec ref: [Subscription-backed reasoning adapter](spec.md#subscription-backed-reasoning-adapter).
  What to build: Version-pinned stdio adapter, model/access detection, narrow MCP bridge, bounded tools, cancel/reconnect handling, allowance status, and no-paid-fallback behavior. Use a reviewed image and fixture evidence; run a real local simulation through an allowed tool and return an evidence-linked recommendation.
  Acceptance: Image → model → allowed tool → actual simulator result → validated answer succeeds under the user's supported subscription route. Disallowed shell/file/device actions are unavailable or blocked by enforceable configuration. A model/allowance error is visible; no hidden downgrade, credit reset, or API fallback occurs.
  Verify: One explicitly authorized live proof plus protocol-replay tests for cancellation, rerouting, limits, malformed output, tool denial, and stale results. Inspect actual model and tool log. If this gate fails, isolate the cause before increasing product complexity; other local-only work may continue.

## Evidence and interaction lanes

- [ ] **3. Integrate KiCad and real circuit simulation**

  Spec ref: [Circuit engine](spec.md#circuit-and-evidence-engine); [diagnostic engine](../architecture/diagnostic-engine.md).
  What to build: Reviewed imports, normalized graph, model/pin-map validation, diagram display, bounded ngspice runner, result parsing, hashes/logs, tolerances and cancellation. Add the two passive fixtures plus invalid/missing-model cases. Preserve source projects.
  Acceptance: Actual node results match independent hand-calculated references within declared tolerances. Failed simulation is visibly failed; a KiCad export is not reported as a physical test. Unsafe/unreviewed simulator content is rejected.
  Verify: Golden-output integration tests against installed executables, malformed/path-traversal cases, pin-map checks, and repeatability across saved revisions.

- [ ] **4. Complete the adaptive measurement and diagnosis loop**

  Spec ref: [Circuit engine](spec.md#circuit-and-evidence-engine); [shared contracts](../architecture/contracts.md).
  What to build: Measurement requests/candidates/confirmation, evidence provenance, ranked alternatives, discriminating test selection, context invalidation, repair verification, and session report. Start with typed entry so AI behavior is not entangled with microphone errors.
  Acceptance: Two faults that give the same initial reading remain distinguishable through a later test. Contradictory, corrected, unknown, and multiple-fault evidence are handled without invented certainty. Safety prerequisites and probe endpoints are explicit.
  Verify: Fixture-driven sessions, independent review of electrical reasoning, board-edit-during-turn tests, stale confirmation rejection, and one real powered/de-energized measurement workflow supervised by the user.

- [ ] **5. Connect both cameras, spatial overlays, and meter candidates**

  Spec ref: [Live perception](spec.md#live-perception-and-crosshair-aiming); [hardware and vision](../architecture/hardware-and-vision.md).
  What to build: iPhone Camo USB capture, Pi Picamera2 Ethernet capture, latest-frame queues, calibrated image transforms, target registry, zoom/circle overlays, manual mapping correction, and HT118A display OCR candidates. Keep emission disconnected.
  Acceptance: Both real feeds run simultaneously without a growing frame backlog. The same target remains correctly located through UI zoom and board pose updates. Blank/ambiguous/mode-changing meter images are not silently accepted as numbers.
  Verify: Held-out marker/target images, actual dual-camera latency and disconnect tests, sign/decimal/unit OCR corpus, frame freshness tests, and on-device focus/crop changes. Do not replace a failed live feed with an unlabeled recording.

- [ ] **6. Let users ask questions and report readings by voice**

  Spec ref: [Two-way voice](spec.md#two-way-voice-and-companions); [voice design](../architecture/voice-and-interaction.md).
  What to build: Persistent local transcription, push-to-talk, deterministic reading parser, clarification/readback, spoken confirmation/correction, captions, local stop, and ElevenLabs streaming approved segments. Use mock speech output until a live provider test is authorized and budgeted.
  Acceptance: A user asks a question, receives spoken guidance, reports a signed measurement with a unit, confirms it, and corrects it. The diagnostic ledger contains only the confirmed interpretation. Own-speaker echo, silence and partial transcripts do not commit a result.
  Verify: The voice corpus in the [verification plan](../testing/verification-plan.md), microphone/speaker failure, stale "yes," TTS cancellation, and noisy-bench trials. Measure the entire loop, not vendor synthesis time alone.

## Physical guidance and broader capabilities

- [ ] **7. Drive yaw and pitch using the calibrated crosshair**

  Spec ref: [Crosshair aiming](spec.md#live-perception-and-crosshair-aiming); [controller detail](../architecture/hardware-and-vision.md#yawpitch-control-with-a-calibrated-aiming-crosshair).
  What to build: Two-axis driver behind a bounded controller; travel/speed limits; camera/beam-plane calibration representation; target and predicted crosshair overlays; measured local image-error-to-motion mapping; deadband, backlash handling, settle/reacquire, and fault/timeout paths. First use simulator/replay, then motor-only hardware.
  Acceptance: Both axes converge on held-out image targets without repeated AI calls. Lost pose, changed depth, stuck axes, out-of-range requests and oscillation stop the loop. Predicted crosshair and observed spot are distinguishable.
  Verify: Mechanical fit and wiring review first; laser physically disconnected; record repeated approach directions, calibration residuals, convergence and ribbon clearance. Crosshair convergence is not yet beam-placement verification.

- [ ] **8. Validate safe physical pointing end to end**

  Spec ref: [Hardware safety](../architecture/hardware-and-vision.md#pointer-controller-and-independent-fail-off).
  What to build: Reviewed module/driver/power wiring, physical kill/held enable, independent normally-off timeout, Pi supervision, authenticated command acknowledgments, and short bounded stationary indication. Implement semantic target selection tied to speech/overlay revisions.
  Acceptance: Physical pointing meets the measured safe target-region accuracy and fails off on kill, lost camera, stale state, stuck enable, process failure and disconnected Ethernet. No emission during motion/probing. Unknown laser specifications keep this milestone blocked, not bypassed.
  Verify: Safe dummy-load tests before any laser; user-supervised actual alignment and independent cutoff measurement; record exact hardware and error margins. **Mandatory hands-on pause:** do not energize hardware based on documentation or simulated tests alone.

- [ ] **9. Add assembly and reassembly tutoring**

  Spec ref: [Circuit engine](spec.md#circuit-and-evidence-engine); [assembly design](../architecture/diagnostic-engine.md).
  What to build: Breadboard connectivity graph, rail breaks, validated hole assignments, component pin/orientation rules, ordered build steps, alternatives, power checkpoints, spoken follow-ups and pause/resume. Reuse the common target/voice/evidence systems.
  Acceptance: A user can build or reassemble a reference circuit from an electrically validated placement plan; wrong rail/polarity/pin assignments are detected. A changed layout is revalidated rather than treated as cosmetic.
  Verify: Graph equivalence tests and power-off checks, one real assembly walkthrough, then actual predicted-versus-measured operation. A photo alone cannot mark assembly electrically verified.

- [ ] **10. Extend diagnosis to active circuits and firmware problems**

  Spec ref: [Diagnostic engine](../architecture/diagnostic-engine.md).
  What to build: Supported model/analysis registry, transient result display, a reviewed active-component fixture, MCU board/pin profiles, source/configuration evidence, safe build-log ingestion, serial observations, and discriminating hardware-versus-code tests. Select the actual available MCU with the user before defining its fixture.
  Acceptance: A wiring fault, a faulty/misconfigured component case, and a firmware/configuration case follow distinct evidence paths. Unknown deployed firmware and absent measurement bandwidth remain visible limitations. No arbitrary build script execution or flashing by model instruction.
  Verify: Independent simulator/model checks and matched firmware/hardware cases with logs and physical observations. Device resets or flashing require explicit user authorization and a safe bench state. Mark unsupported cases honestly.

- [ ] **11. Finish the live companion and hands-free experience**

  Spec ref: [Two-way voice and companions](spec.md#two-way-voice-and-companions).
  What to build: Frieren asset integration, bottom-right companion window, activity/mouth animation, captions, reduce-motion/hide controls, three-slot character registry, tested hands-free VAD/echo cancellation/barge-in, and the remaining character packs after identities/assets are approved.
  Acceptance: The first guide works alongside the bench and other laptop applications. User interruptions stop old audio and stale instructions. Character changes cannot change evidence or safety rules. All three completed character choices require actual selected assets, not duplicate placeholders.
  Verify: Real speaker/microphone/noise tests with both camera streams running, focus/multi-window/accessibility tests, asset/voice provenance review, and state consistency after session restart. Keep missing character choices explicitly open.

## Release evidence

- [ ] **12. Harden, measure, package, and record the demonstration**

  Spec ref: [Risks, verification, demo](spec.md#risks-and-verification); [verification plan](../testing/verification-plan.md).
  What to build: Repeatable start/setup checks, recovery, private-data retention/export, dependency notices, clean package, performance report, session evidence report, demo recording, and user-facing limitations. Review current event rules separately before preparing its submission text.
  Acceptance: A clean start and complete real diagnostic session succeed with confirmed physical data and a post-change retest. Safety failures stop correctly. Each requirement is marked demonstrated, automated-only, manual-only, incomplete, or unsupported; no hidden prerecorded substitutions.
  Verify: Independent acceptance review, 30-minute integrated session, reconnect/crash tests, privacy and staged-file audit, readable Git history, and the full demonstration on actual equipment. No automatic publication of recordings or event submission.

## Scheduling rule

Critical path: foundation → subscription proof + real circuit tools → confirmed diagnostic loop → integrated user session → final verification. Cameras and voice can progress in parallel after contracts stabilize. Motors require mechanical/electrical checks; laser emission waits for its separate safety gate. Assembly, firmware breadth, and companion polish build on the same evidence and interaction contracts.

If time becomes short, report which requirements are still incomplete and choose the strongest fully verified demonstration with the user. Do not silently remove full-product requirements or advertise a fallback as the completed requested feature.
