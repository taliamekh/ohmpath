# Ohm Path

A live electronics bench assistant that sees the circuit, listens to the person, tests explanations against simulation and real measurements, and shows exactly where to look next.

**Status: runnable Windows desktop development build.** Local circuit simulation, explicit measurement readback, local speech recognition, evidence history, camera selection, assembly/firmware guidance, and a simulated two-axis pointer are implemented. Hardware acceptance and the complete product checklist remain pending. See the [handoff report](docs/development/morning-report.md) for launch steps, actual verification and limitations.

The [afternoon handoff](docs/development/afternoon-report.md) records the latest countryside theme, simplified logo, expressive guide, fullscreen/subtitles, Photo help and silent verification follow-up.

Repository: [taliamekh/ohmpath](https://github.com/taliamekh/ohmpath).

## Start here

1. [Product requirements](docs/hackathon-build/prd.md) — what the complete product must do.
2. [Technical build plan](docs/hackathon-build/spec.md) — architecture, technology choices, costs, and file layout.
3. [Build checklist](docs/hackathon-build/checklist.md) — order of work and evidence required to finish each milestone.
4. [Subagent work plan](docs/development/subagent-work-plan.md) — task ownership, parallel work, and integration rules.
5. [Verification plan](docs/testing/verification-plan.md) — how we distinguish a convincing explanation from a tested result.

## Detailed design

- [Circuit diagnosis and assembly](docs/architecture/diagnostic-engine.md)
- [Cameras, Raspberry Pi, and physical pointing](docs/architecture/hardware-and-vision.md)
- [Two-way voice and animated guides](docs/architecture/voice-and-interaction.md)
- [Shared data and service contracts](docs/architecture/contracts.md)
- [Evidence, decisions, and unresolved prerequisites](docs/hackathon-build/build-notes.md)
- [Repository and readable commit rules](CONTRIBUTING.md)

## Chosen direction

Ohm Path runs as its own Windows desktop application. The laptop handles the interface, circuit model, KiCad imports, ngspice simulations, local speech recognition, evidence history, and camera processing. A Raspberry Pi 5 with Camera Module 3 Wide connects over Ethernet and controls the physical pointer. An iPhone supplies a separate USB camera view.

Cloud reasoning connects through the user's local, signed-in Codex installation, subject to account access and allowance. ElevenLabs supplies spoken responses separately. Neither cloud reasoning nor paid voice is described as unlimited or free. A model suggests and explains; Ohm Path validates evidence and controls what can actually happen.

The first companion is Frieren, with six reference-based poses and a floating companion. Thinking, stumped, happy, smug and weary expressions follow activity or explicit feedback; local ear, arm and clothing animation keeps the face anchored. The countryside interface uses painted raster artwork, wooden trail signs and an Omega-shaped path logo. The design documents preserve future guide slots; unused slots are not shown in the interface. Public asset permission and voice playback verification remain pending.

## Historical material

The project was previously called Benchmate. Existing `outputs/` files remain unchanged locally; the plans above supersede their software architecture and scope restrictions. They are not automatically published because that folder mixes private notes, generated files, and earlier event material. Approved mechanical sources and clean test fixtures will be curated into the organized project during implementation.

## Run the development build

On this prepared Windows checkout, double-click `scripts/start.cmd`. The desktop starts its own private local service and stores session evidence in local application data. Closing the desktop closes that service. No camera or microphone opens until explicitly selected, and no physical actuator driver is enabled. `scripts/start.cmd` does not require changing PowerShell execution policy.

For a fresh checkout, use Python 3.12+, Node.js 22+, and pnpm 11, then run:

```powershell
python scripts/setup.py
./scripts/start.cmd
```

Setup uses the pinned dependency locks and pnpm 11.25.0. `python scripts/setup.py --check` checks the prepared files without installing. The alternate `./scripts/setup.ps1 -WithSpeech` also installs the free local whisper.cpp worker and English speech model where local PowerShell policy permits; the application does not override that policy. ngspice is required for actual local solves; KiCad 10 is required for schematic export. Existing Windows per-user installations are detected. Optional `OHMPATH_NGSPICE` names a reviewed executable for standalone service use; the KiCad adapter currently pins the reviewed per-user KiCad 10 installation.

Start in **Camera help**, or choose **Photo help** to upload a circuit photo or diagram without a camera or turret. Ask explicitly to send the selected images through the signed-in subscription. Camera previews start only after connection; analysis uses the snapshot you choose, not continuous unattended capture.

Use **Full screen** to hide navigation and place Frieren at the bottom-right. **Subtitles on/off** also works without audio; the preference is available in Settings and survives relaunch. Snapshot questions open inside the camera workspace. **Back to camera** hides the review drawer while keeping your question and preview available. Press Escape to leave fullscreen, or **Pause previews** to stop capture.

Under **Measurements and circuit tools**, create a practice bench, choose a fixture, and run the local solve. Review the declared setup before starting a measurement request. Enter a signed value with units, check its complete readback and explicitly confirm it. Practice inputs remain labeled simulated user input, distinct from physical measurements.

Run `.venv/Scripts/python.exe scripts/verify.py --no-voice` for the explicit offline circuit, photo, camera, image and desktop verification profile. It excludes speech and ElevenLabs tests, uses synthetic cameras and performs no physical test. Add `--list` to inspect its commands without executing them. The default profile also includes voice mocks; it remains separate from the user's current no-voice verification request. `scripts/verify.ps1` forwards these options where local PowerShell policy permits. See the [Pi source deployment bundle](docs/development/pi-deployment.md) and [controller commands](docs/development/pi-controller-handoff.md) for the separately packaged Pi service. No Pi installation, SSH connection, flashing or motor operation has been performed.

The subscription investigator requires the existing signed-in Codex CLI version recorded in [the adapter handoff](docs/development/codex-adapter-handoff.md), access to the configured Astra model, and sufficient subscription allowance. It starts only on request, checks that access, and fails closed. It does not switch to API-key billing. Local speech output is optional and explicit. Settings can [link an ElevenLabs account without generating speech](docs/development/elevenlabs-connection.md); the current account is linked privately, with generation disabled as requested. Playback remains untested. See [visual workspace verification](docs/development/visual-workspace.md) for the new UI and photo-help boundaries.

## Available tools in the interface

- **Camera help:** large overview/Pi views, explicit snapshot questions and Frieren. Expand **Measurements and circuit tools** for practice/manual sessions, reviewed KiCad import, actual ngspice, signed readings, readback/confirmation, corrections, fault comparisons and local report export. Manual confirmation records what the user reports; it does not verify the instrument.
- **Photo help:** upload or explicitly paste up to three circuit photos or diagrams, with short answers, follow-up questions and image annotations, without a camera or turret. Images and completed replies stay in memory across page changes; Clear workspace releases them. Only Ask sends images. Quitting/reloading discards the temporary workspace. Photo reasoning has no practice graph or model tools. It cannot confirm measurements or operate devices.
- **Circuit and firmware tools** (inside the expanded bench tools): logical assembly guidance, supplied firmware-log analysis and the evidence-backed circuit investigator. Historical Circuit lab source/templates remain preserved; its menu was replaced at the user's request.
- **Devices:** an explicitly selected local overview camera, optional authenticated Pi camera preview through an already prepared SSH tunnel, offline yaw/pitch calibration candidates, and a synthetic aiming animation. Both actual camera feeds and physical calibration remain unverified.
- **Settings:** turret on/off preference, reference-based Frieren expressions, reduced animation, optional local system speech, encrypted ElevenLabs connection and a separate floating companion. Turning the turret preference on saves setup intent; physical motion and laser remain disabled.

Meter-image OCR is optional and currently unavailable on this machine; typed and voice candidates still require the same confirmation. The full requirements in `docs/hackathon-build/` remain in scope even where this development build is incomplete.
