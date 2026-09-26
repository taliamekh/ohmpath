# Ohm Path product requirements

Planning baseline: September 26, 2026. This document captures the user's current requirements and supersedes the old Benchmate software scope. It is not a claim that the product is implemented.

## Product promise

An electronics assistant that can see a physical circuit, understand its intended operation, guide a person through useful tests, interpret the results, and help them assemble or repair it. Guidance is visual, spoken, and physically located. The assistant can conclude that the likely problem is wiring, a component, power, or code; it can also say the current evidence is insufficient.

The product owns a real circuit-testing workflow. It is not only a chat window attached to a model.

## Primary experience

1. Open Ohm Path; select the circuit or import a design, establish the bench view, and confirm power conditions.
2. Ask aloud, "Why is this not working?" or "Help me build this circuit."
3. See likely explanations with evidence and the next useful test, including meter mode and exact probe locations.
4. The view zooms and highlights the target. When independently armed and safe, the turret points to the corresponding physical location.
5. Speak the reading, let the camera propose a meter reading, or type it. Ohm Path reads back the value, units, mode, and probe locations for confirmation.
6. Compare confirmed results with actual simulations and other evidence. Update hypotheses, explain their meaning, and select the next discriminating test.
7. Make the change, then repeat the relevant tests. Save a report that separates the suspected cause, actual change, and verified outcome.

## Requirements by epic

### See and locate the circuit

Provide a live iPhone view and a Pi Camera Module 3 Wide view, selectable or shown together. Distinguish intended connections from visual suggestions. Support geometric calibration, manual correction, close-up crops, tracking, confidence indicators, and stale-view warnings. A hidden wire is not a proven electrical connection.

The onscreen zoom, circle, spoken instruction, and physical pointer must refer to the same versioned semantic target. Do not promise single-hole laser accuracy before measuring it.

Code both turret axes: yaw and pitch. Show an aiming crosshair in the Pi camera view and align it with the chosen target using a fast local feedback controller. The crosshair represents a calibrated prediction of laser placement, not an assumed image center. Account for camera/laser offset and depth; distinguish an observed spot from a prediction. The AI must not repeatedly analyze every frame just to steer the turret.

### Diagnose with evidence

Use KiCad imports and real ngspice analysis. Compare expected ranges against confirmed measurements, taking tolerance and measurement conditions into account. Rank multiple explanations; choose safe tests that distinguish them. Support unresolved and multiple-fault outcomes. Keep an audit trail showing what changed a conclusion.

Build a firmware branch using source review, board/pin configuration, build outputs, serial logs, and reproducible input/output tests. A working simulation does not prove the real hardware or its code works. No autonomous flashing or physical repair.

### Teach assembly and reassembly

Translate a validated circuit into a specific breadboard layout: rail breaks, hole groups, pin orientation, component values, power connections, and staged checks. Give one actionable step at a time with zoom/pointing. Let users ask why, repeat a step, change an available part, and resume after interruption. Revalidate the electrical graph after an alternative layout or part is chosen.

### Listen and speak

The user must be able to ask questions and read measurements aloud. Spoken answers use ElevenLabs. Provide push-to-talk, then a tested hands-free mode with interruption handling, visible listening state, mute, captions, and typed controls. Ask again for ambiguous numbers, sign, decimal, unit, or measurement location. Never interpret silence as confirmation.

Voice input is a first-class workflow, not a microphone icon without a working measurement pipeline.

### Provide animated guides

Show the first guide, Frieren, animated at the bottom-right while Ohm Path is live. Expose three character slots through a shared guide interface; the other two are not yet specified. Switching guides changes presentation, not facts, tool permissions, or safety behavior. Provide idle/listening/thinking/speaking/paused states, minimal mouth animation, captions, and a hide/reposition control. Ship only cleared assets and an authorized voice; do not clone an actor by assumption.

### Stay responsive and trustworthy

Keep local video and interaction running while the AI reasons. Prefer meaningful keyframes and explicit measurement events to continuous cloud inference. Show what is being checked and distinguish unavailable service from "nothing is wrong." Cancel obsolete answers, stop unsafe or stale actions, and recover after network interruption without silently replaying motor commands.

### Respect budget and privacy

Use the existing signed-in Codex connection for the personal prototype where the account supports it. No API billing by default, no Jev dependency, and no local reasoning-model requirement. Dedicated local speech/vision tools are allowed. ElevenLabs usage is separate and must be visible. Raw audio/video recording is off by default; disclose which cropped images, circuit data, or speech text go to cloud providers.

## Capability growth, not an arbitrary ceiling

Start with passive DC circuits to validate the whole loop, then add nonlinear/active models, transient analysis, MCU/firmware diagnosis, and larger assemblies with explicit support metadata. Missing component models or instruments should produce a precise limitation or a request for evidence, not a fabricated result. Arbitrary unknown boards are an exploration mode until their intended circuit and critical connections are established.

The full plan includes every epic above. An incomplete milestone must remain marked incomplete rather than disappearing from the plan when the event clock gets tight.

## Safety and completion

Initial physical operation is restricted to current-limited low-voltage bench circuits. High-energy/mains work, autonomous power switching, and unrestricted laser operation are outside this build. The physical pointer cannot be considered delivered until its hardware and safety checks pass.

A complete demonstrated workflow includes a real user question, real circuit evidence, an actual simulator run, a confirmed physical measurement, a useful next test, spatial guidance, a verified post-change result, two-way voice, and the first animated guide. Three completed character choices require the remaining character and asset decisions; a registry alone is only infrastructure.
