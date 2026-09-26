# Ohm Path technical build plan

Status: selected architecture and implementation sequence, not a completed integration. Updated September 26, 2026. Requirements are in the [PRD](prd.md); execution order is in the [checklist](checklist.md).

## Overview

Build an independent Windows desktop application around a circuit evidence engine. The model investigates and explains; local code owns simulation, measurements, geometry, session state, and device control. The user can speak naturally, read measurements aloud, ask how to assemble a circuit, and receive synchronized spoken, onscreen, and physical guidance.

Use the strongest already-available subscription-backed model as the first reasoning path. Do not replace it with a weaker local reasoning model to save money, continuously send video to the cloud, or train a custom model before the evidence harness works. Most testing uses deterministic fixtures and recorded, sanitized cases.

Research establishes a plausible supported integration path, not a guarantee of accuracy or zero debugging. The first build gate proves the actual image → tool → simulator → answer loop. Physical accuracy and noisy-bench speech require experiments with the real equipment.

## Stack

| Layer | Selected implementation | Reason |
| --- | --- | --- |
| Desktop | Electron, React, TypeScript, Vite | Native Windows companion window, camera/microphone permissions, app lifecycle |
| Bench service | Python, FastAPI, Pydantic | One authority for evidence/state; direct access to vision and circuit tooling |
| Persistence | SQLite plus private local evidence files | Transactional session history without a hosted database |
| AI integration | Local Codex app-server over stdio, narrow local MCP adapter | Existing user sign-in and subscription route; provider isolated behind an interface |
| Reasoning model | `gpt-6-astra`, standard speed; medium initial effort, explicit escalation for hard cases | Locally listed text/image access; compare quality and latency in project evaluations |
| Circuit tools | KiCad CLI and ngspice subprocess adapters | Real design imports and numeric simulations |
| Vision | OpenCV, marker/feature geometry; pluggable meter OCR | Local fast tracking; visual model used only for meaningful interpretation |
| Voice input | whisper.cpp, `small.en` initially, measured Vulkan option and CPU fallback | Dedicated local transcription without per-request transcription billing |
| Voice output | ElevenLabs Flash v2.5 streaming | Requested voice provider; independent budget and credentials |
| Pi | Raspberry Pi OS, Python/Picamera2, bounded motor/controller service | Camera and physical device ownership near the hardware |
| iPhone | Camo USB to a Windows virtual camera | Avoid venue peer-to-peer Wi-Fi and a custom iOS app initially |
| Verification | pytest, frontend unit tests, Playwright, recorded fixtures, physical checklists | Test each layer separately and the complete workflow |

Pin actual dependency versions and lockfiles during the foundation milestone after compatibility checks. Do not interpret this table as dependencies already installed or tested together. whisper.cpp is a speech recognizer, not the circuit reasoning model. Character animation starts with a small sprite/state renderer; a complex avatar SDK is not a prerequisite.

## Architecture

```text
iPhone --USB/Camo--> desktop preview -----------+
microphone --------> local speech worker -------+
                                               v
                                    Laptop bench service
Pi camera --direct Ethernet--> vision --> evidence + session ledger
                                               |
                    +--------------------------+----------------------+
                    |                          |                      |
             KiCad / ngspice          local Codex adapter     approved speech
                    |                 cloud reasoning                |
                    +--> validated test proposal <--------+     ElevenLabs
                                      |                              |
                             shared target + revision       speaker + avatar
                                      |
                    +-----------------+-----------------+
                    |                                   |
             onscreen zoom/circle             local aiming controller
                                                   yaw / pitch
                                                        |
                                          Pi + independent safety gate
```

This is an architectural diagram, not an implemented connection. Internet is needed for cloud reasoning and ElevenLabs, but camera tracking and hardware shutdown do not depend on it.

### Desktop and lifecycle

Maps to PRD: see and locate, animated guides, responsiveness.

Electron main owns startup/shutdown of the bench service and microphone/camera permissions. The renderer receives only narrow validated application messages: no Node integration, no direct shell/device/secret access, context isolation enabled. Bind the bench API to loopback with a per-launch token, strict origins, and a bounded WebSocket event stream. Never expose all backend controls on school Wi-Fi.

Main screen: live camera area; circuit/schematic and measurements; current test card with large probe labels; evidence-backed explanations; captions/voice controls; and visible service/safety status. The bottom-right companion can be a separate transparent, movable window while the bench is active, so it remains available alongside KiCad or code. Click-through applies only to decorative areas; controls remain operable. Pause/hide must be obvious.

Use a separate latest-frame video path; do not serialize full-resolution frames into SQLite or every UI event. The laptop service owns the session state; a renderer restart must not create a second independent diagnosis or replay a physical action.

### Circuit and evidence engine

Maps to PRD: diagnose, assembly/reassembly, trustworthy results.

Keep intended design, observed wiring, confirmed measurements, and firmware evidence separate. Import a reviewed KiCad project into a versioned normalized graph; validate models, ground, pin mappings, and units before generating analysis jobs. Store actual simulator logs and numeric results with their inputs. Reject arbitrary executable/control content in imported data.

Generate competing explanations, use evidence to rank them, and select a useful admissible next test. Do not manufacture confidence percentages. A model may propose new hypotheses, but local validators check references, units, prerequisites, and tool results. A confirmed abnormal reading is not "corrected" to the simulated value.

Implement breadth through circuit profiles, model packages, instrument adapters, and explicit unsupported conditions. Passive divider fixtures are the first regression suite. Active circuits, transient behavior, and MCU code become further supported capabilities with matching evidence requirements. See [diagnostic engine](../architecture/diagnostic-engine.md).

### Subscription-backed reasoning adapter

Maps to PRD: diagnose, privacy/budget, responsiveness.

OpenAI documents app-server embedding, stdio transport, image inputs, streamed events, account state, and rate-limit reporting. Local MCP servers provide a tool connection. The app-server command is experimental, so isolate and pin the adapter rather than promise production stability. [App-server documentation](https://learn.chatgpt.com/docs/app-server), [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)

Planned sequence: start child process; initialize; verify account/model capability; establish one session conversation; send a selected image and compact evidence snapshot; allow bounded tools; validate the returned recommendation; cancel obsolete turns. Generate or inspect protocol schemas matching the installed version when implementing rather than guessing wire fields from this plan.

The bench service supervises the adapter. A tiny stdio MCP bridge calls the authoritative service with an ephemeral local capability token; it must not duplicate the evidence database. Allow tools such as `get_session_evidence`, `get_circuit_graph`, `simulate_variant`, and `propose_test`. Tool results reference immutable evidence IDs. Confirmation and laser arming are never model-callable capabilities.

Runtime Codex must not inherit broad development permissions or unrelated global MCP connections. The first gate must demonstrate restrictive configuration: no arbitrary shell, general filesystem mutation, browser automation, or access to secrets; only intended tools and sanitized session inputs. If the installed version cannot enforce that boundary, block live-device integration and review the adapter before proceeding. Do not pretend a prompt alone is an access control.

Local inspection previously established signed-in access and a text/image Astra model listing. It did not establish end-to-end circuit accuracy. Run the same evaluation cases after model/version changes; record requested and actual model and any rerouting. Do not silently switch to another model or sell a shared backend powered by one personal login.

### Live perception and crosshair aiming

Maps to PRD: see/locate, physical guidance, responsiveness.

Use a fixed iPhone overview and the moving Pi camera. The AI identifies a component or node; the user/graph mapping establishes its semantic target. OpenCV then tracks board geometry and target position locally. Zooming the display changes rendering, not the underlying physical calibration.

The turret controller aligns a **calibrated aiming crosshair** with the requested target in the Pi image. Calculate pixel error between target and predicted beam-plane intersection; convert that into small yaw/pitch corrections using a measured local calibration/Jacobian. Apply travel limits, rate limits, deadband, settle-and-reobserve, and timeout/oscillation detection. Never ask the cloud model for servo angles every frame.

The Pi camera is mounted above and moves with the laser. The current design has a nominal 24 mm optical-axis separation, so parallax and target depth matter. A fixed center crosshair is not automatically the laser position. Calibrate on the working plane, refresh pose after motion, and require a valid depth/plane model for elevated targets. Display predicted reticle and actually observed laser spot differently. Crosshair alignment is not physical proof of beam placement.

Start with a laser-disabled target board and motor tests. Only after separate hardware gates pass may pointing be enabled, with emission off during motion and loss of tracking. See [hardware and vision](../architecture/hardware-and-vision.md).

### Two-way voice and companions

Maps to PRD: listen/speak, animated guides, accessibility.

Local transcription produces text candidates. Questions go to the investigator; measurements go through a deterministic parser and explicit confirmation transaction. Partial recognition, silence, background speech, and the app's own voice cannot commit readings. The same test request links speech, probe instructions, overlay, and evidence.

Implement push-to-talk first, then complete hands-free voice with measured echo cancellation and barge-in. A local stop action cancels queued speech/guidance immediately; it does not replace a physical emergency stop. Stream only approved complete instruction segments to ElevenLabs, not unvalidated model tokens. Flush old speech and pending pointers when context changes.

An avatar registry defines appearance, permitted voice, animation states, attribution, and user preferences. Frieren is first; the other two identities/assets remain user decisions. Keep exact measurement/safety wording outside persona improvisation. See [voice and interaction](../architecture/voice-and-interaction.md).

### Session storage and recovery

Store events, revisions, measurements, imports, simulations, hypotheses, and accepted test requests in SQLite. Keep raw media out of the database; save approved evidence crops by opaque ID with hashes and retention settings. Default runtime storage goes in the user's local application-data directory, outside this OneDrive workspace and outside Git.

Crash recovery opens paused and disarmed. Preserve the report, but require fresh camera pose, power/setup confirmation, and physical re-arming. Never replay motor commands or assume old readings describe a rewired circuit. Schema migrations are versioned and tested against saved fixtures.

## Planned file structure

Only documentation and repository instructions are created now. During implementation:

```text
apps/desktop/                    Electron shell and React interface
  src/main/                     Process lifecycle and safe IPC
  src/renderer/                 Bench views, overlays, companion, captions
services/bench/
  src/ohmpath/                   Python package
    api/                        Local HTTP/WebSocket endpoints
    session/                    Evidence, revisions, persistence
    circuits/                   Graphs, KiCad, models, ngspice, assembly
    diagnostics/                Hypotheses, test selection, validation
    ai/                         Codex adapter and narrow MCP bridge
    vision/                     Camera sources, geometry, OCR
    voice/                      Transcription, parsing, speech queue
    devices/                    Pi link, instruments, firmware evidence
    safety/                     Preconditions and action authorization
  tests/                        Unit and service integration tests
services/pi/                    Camera, bounded controller, watchdog client
packages/contracts/             Canonical JSON Schema and generated bindings
fixtures/                       Sanitized circuit, image, voice, protocol cases
hardware/                       Curated source CAD, exports, BOM, calibration docs
assets/characters/              Cleared assets and attribution manifests
scripts/                        Reproducible setup, verification, packaging
tests/end-to-end/               Desktop and cross-service scenarios
docs/                           Requirements, design, workflow, evidence
```

No generic dumping-ground `utils` package or giant combined agent file. Own functions by responsibility. Schemas are the source of truth; generated Python/TypeScript bindings are not hand-edited. Dependency changes go through the integration owner to avoid conflicting lockfiles.

## Data flow and synchronization

Each message carries a session ID, event ID, ordering information, correlation ID, and applicable circuit/firmware/calibration revisions. Commands also have expiry, authorization, and acknowledgment. Services reject obsolete or duplicate state-changing requests. See [shared contracts](../architecture/contracts.md).

The fast path updates video, target tracking, and control without waiting for reasoning. The slow path processes meaningful board changes, confirmed measurements, or questions. At most one active diagnostic turn and one measurement request per bench; coalesce repeated changes instead of accumulating requests. Simulator jobs can run with bounded local concurrency. Development subagents are not multiple paid runtime investigators.

Initial performance targets, all **unmeasured**: responsive controls under 150 ms; preview age usually below 250 ms; local tracking roughly 15–20 Hz where hardware permits; finalized short-utterance transcription within 2 seconds at p95 after speech ends; visible acknowledgment immediately while a reasoning answer may take several seconds or longer. Every figure needs a target-device benchmark. See specialized plans for test conditions and safer fallbacks. Never lower diagnostic validation just to hit a latency number.

## External dependencies and cost controls

- Codex uses account allowance under the selected authentication route; API-key usage is a separate billing path. Account limits and model availability must be checked rather than inferred from the plan name. [Official pricing](https://learn.chatgpt.com/docs/pricing)
- Ohm Path defaults to subscription-only operation and no automatic overage/fallback. Before enabling it, check the account's credit settings and available limit signals. Stop new turns with a conservative margin; polling cannot guarantee a hard zero-credit cap for an already-running turn. If strict zero additional spend cannot be assured, say so and leave cloud turns paused until the user chooses.
- ElevenLabs output is separate. Set an approved voice budget and usage display; no automatic top-up. If unavailable, retain captions and optional local accessibility speech, clearly labeled as a fallback rather than the requested voice being complete.
- Camera software compatibility, any Camo feature entitlement, installed tool paths, and speech acceleration are setup checks, not presumed purchases. No extra cloud database or hosted site is needed for the local prototype.
- Cache safe fixed narration; use short relevant crops; replay fixture tests locally; reserve live AI evaluations for meaningful model/tool behavior.

## Risks and verification

The critical risks are the subscription tool loop and permission boundary; visual ambiguity; moving-camera parallax; servo backlash; speech number errors; unvalidated imports; and unknown laser electronics. Each has a gate in the [verification plan](../testing/verification-plan.md). Do not mark a gate passed because the document describes how to pass it.

Unconfirmed prerequisites: exact laser class/power/driver, external servo power and independent kill/watchdog hardware, camera cable, assembled mechanical fit, current iPhone/cable/software compatibility, actual MCU board for firmware fixtures, voice/character assets, and current event deadline/rules. Work that does not require these can proceed; emission, unsupported electrical procedures, spending, and event claims cannot.

## Demo and submission flow

Demonstrate one genuine end-to-end case, then show capability breadth through a second different fault and a firmware/assembly case when their gates pass. Record the real sequence: symptom → ranked alternatives → chosen test → spatial instruction → spoken confirmed result → simulation comparison → repair → repeated successful test. Show uncertainty and disconnection recovery as intentional behavior.

Provide a short recording, setup guide, evidence-backed results, known limitations, attribution, and a clean repository. Confirm the active event's rules and submission timing before tailoring materials. This plan neither asserts eligibility nor authorizes submission. The full product backlog remains visible if the event demonstration covers fewer completed capabilities.
