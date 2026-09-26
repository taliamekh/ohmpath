# Verification plan

No Ohm Path application test or physical integration test has passed yet. This document defines the evidence required during implementation. Earlier tool-installation/CAD checks remain useful but are not substituted for these gates.

## Evidence labels

Every result must be labeled as calculated reference, actual simulation, recorded replay, software integration, user-reported physical measurement, instrument telemetry, or supervised hardware verification. Include versions, fixture/input hashes, timestamps, revisions, expected outcome, actual outcome, and limitations. A report with missing evidence is incomplete.

## Required test suites

| Suite | Minimum coverage | Acceptance gate |
| --- | --- | --- |
| Contracts/state | Units, sign, missing IDs, duplicates, out-of-order events, context changes, corrections, restart | Invalid/stale state cannot commit evidence or trigger an action |
| Circuit tools | Two passive fixtures, hand-calculated voltages, missing ground/model, wrong pin map, failed convergence, invalid imports | Actual solver results reproducible; expected failures visible |
| Diagnosis | Healthy, open/high-resistance, wrong value, conflicting readings, multiple faults, measurement error, unsupported case | Evidence references valid; useful discriminating tests; uncertainty preserved |
| Firmware | Source/config/deployed mismatch, wrong pin, missing common reference, power failure, firmware error | Cannot assume source is deployed or simulate away an unmeasured hardware fault |
| Assembly | Split rails, connected row groups, polarity, IC orientation, pin mapping, part substitution | Electrical graph matches intended net connectivity; unsafe ordering rejected |
| Camera/OCR | Both feeds, rotation/crop, glare, blur, occlusion, negative signs, decimal/unit changes, OL, blank display | No ambiguous OCR reading silently confirmed; spatial mapping invalidates correctly |
| Voice | At least 100 representative short utterances spanning questions/readings, accents actually in use, digits, signs, milli/micro, OL, silence, echo, background speakers | No unconfirmed value accepted; every ambiguous value corrected/clarified; report raw parse accuracy separately |
| Aiming | Centre/edge/corner targets, two-axis coupling, opposite approach directions, changed depth, lost markers, stuck axis, oscillation | Convergence only within calibrated validity; no cloud call per correction; loss of state stops action |
| Hardware safety | Physical stop, stuck-high enable, killed Pi/desktop process, stale heartbeat, unplugged Ethernet/camera, reboot | Independent electrical emission cutoff verified with safe load before any laser test |
| End to end | Typed then spoken measurement, actual simulation, live overlay/pointing when permitted, revision change, repair/retest | Complete repeatable real session with traceable evidence |

Zero unsafe acceptances in a finite test corpus is a release criterion, not proof the system can never fail. Record false acceptance, false rejection, correction rate, and the denominator; do not advertise a broad accuracy percentage from a tiny curated demo.

Specific cross-layer regressions: switching meter mode or supply state without changing the circuit graph must invalidate a pending confirmation; reusing a command ID with a changed payload must fail; disconnect/disarm must invalidate authorization epochs; MCP cannot reach user-only confirmation/arming paths; crosshair alignment alone cannot enable emission.

## Live model evaluations

Most tests use deterministic recorded model/tool responses. Maintain a small separate live evaluation set covering image uncertainty, tool grounding, ambiguous diagnosis, firmware evidence, and unsupported claims. Live runs require available account allowance; use identical case IDs to compare model/version changes. Record requested/actual model, reasoning setting, tool calls, latency and grading outcome. A correct answer without the required evidence path does not pass.

Require enforceable runtime tool restrictions before connecting real hardware. Deliberately inject instructions into imported labels, transcripts and documents and verify they remain untrusted data. Test model requests for arbitrary shell access, file disclosure, confirmation bypass and arbitrary motor control; none are permitted.

## Physical measurement and aiming acceptance

Have the user inspect the circuit/meter setup and power limits. Record meter mode/range, both probe endpoints and uncertainty. A confirmed spoken value remains user-reported, not digitally acquired. Re-test after a repair using the same quantity and conditions; do not count a changed screenshot as proof.

For pointing, use independently measured held-out locations throughout the safe plane and repeated approach directions. Record prediction error and actual spot error separately. Set the allowed pointing region from worst observed error plus a declared margin; shrink supported workspace or use larger matte labels when needed. No breadboard-hole precision claim without suitable evidence. Elevated components need a verified depth model or remain unpointable.

Hardware checks pause for user participation. Neither agent nor test script may energize an unknown laser or run powered movement before the wiring/fit review. Measure cutoff electrically; a software log saying "off" is not enough.

## Performance protocol

Measure a 30-minute integrated run with both camera feeds, voice worker, companion and diagnostic service active. Report median and p95 where there are enough samples, maximum frame age, dropped frames, memory growth, CPU/GPU load, timeouts, speech end-to-transcript time, approved-text-to-audio time and local stop latency. Report model reasoning separately from video/controller timing.

Use the initial targets in the hardware and voice designs; change a target only with an explanation and recorded result. Reducing safe-validation requirements to make a demo feel faster is not an optimization.

## Readiness record

For each checklist milestone, record status as not started, implemented/unverified, automated checks passed, physical checks pending, demonstrated, or blocked with the exact missing prerequisite. Link evidence and the human-readable commit. Final review covers remaining requirements, privacy, licenses, event eligibility, setup reproducibility, and recovery after failure. Do not imply a complete product when only the passive-fixture slice is demonstrated.
