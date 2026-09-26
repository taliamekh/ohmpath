# Software verification

Ohm Path is a runnable Windows desktop development build. The complete product milestones remain open until their required physical and clean-install evidence exists. This page distinguishes working software from unverified hardware and user-environment behavior.

## Launch

On a prepared checkout, open `scripts/start.cmd`. A fresh checkout needs Python 3.12+, Node.js 22+, and pnpm 11.25.0, then `python scripts/setup.py`. Install KiCad 10 and ngspice for their respective circuit tools. Local speech also requires the separately installed whisper.cpp worker and model described in the README. Setup does not change PowerShell policy or enable hardware.

The desktop starts its own private local service and shuts it down when closed. Live help offers explicit camera selection and snapshot questions. Photo help accepts selected images and optional phone photo transfer. Spoken questions fill an editable draft; only Ask submits it. Voice playback starts disabled each launch and Listen is explicit. Turret preference records setup intent; physical actuation remains disabled.

## Implemented and verified software

| Area | Evidence | Boundary |
| --- | --- | --- |
| Circuit tools | Installed KiCad 10.0.6 exported the reviewed passive-source schematic; installed ngspice 47 produced 3.300000 V. Both passive golden fixtures matched independent reference voltages. | Simulation prediction, not a measured physical circuit. Active components and arbitrary SPICE directives are unsupported. |
| Backend and contracts | Latest local suite: 417 tests passed, two optional Windows OCR tests skipped because shell policy blocks their helper. Python lint and generated-contract consistency passed. | One existing Starlette/httpx deprecation warning remains. |
| Local vision | Fifteen synthetic backend/API tests and a production Electron regression with synthetic camera video and the real OpenCV service passed. Separate backend and UI reviews found no blocking defects. | Tracks an explicitly selected image feature. No automatic circuit connectivity, physical accuracy, electrical confirmation, or calibrated aiming claim. |
| Phone photos | Eight local bridge tests plus the production phone page in Chromium passed: bounded resize, explicit Send, preview, expiry and cancellation. | Actual iPhone Safari, Wi-Fi/firewall and USB live-camera behavior await device checks. The local trusted-network HTTP link is unencrypted. |
| Spoken input | Mocked draft-only capture/cancellation checks passed. Installed Whisper recognized one synthetic local question correctly on CPU. | Real microphone, room noise, speaker echo and simultaneous dual-camera behavior remain unverified. |
| Voice output | Bounded streaming, cancellation and budget checks pass offline. A separately authorized short provider transport check returned PCM successfully. | No actor/character voice match or audible physical-speaker quality is claimed. The saved stock voice is not an exact anime performance. |
| Theme and fullscreen | Solid dark green title bar, countryside continuation, caption-control spacing and readable signpost navigation are implemented; synthetic layout checks passed. | Native Windows caption-control overlap still needs a direct window check. |

## Integrated checks

The full desktop regression run completed with 20 passes and one stale test assertion: recovery now reads ElevenLabs status without generating speech, and the test's exact action list omitted that new read. The expected list was updated; the failed test passed in isolation afterward. This was not a voice-generation or renderer failure. All 21 cases therefore have passing evidence, with the recovery case rerun separately. The explicit silent verification profile now includes local vision and phone transfer.

An elapsed 30-minute synthetic animation diagnostic is running on the integrated build. Earlier long checks failed on a pixel mismatch after approximately 17 minutes. The improved diagnostic retains same-frame mismatch images; accelerated phase/fullscreen tests and a short elapsed run passed. Those short checks do not establish long-run stability.

The public photo-help feature branch passed its Linux workflow, including locked dependency installation, contracts, Python tests, renderer build and desktop bridge tests. An older branch exposed a test race in cancellation cleanup; the test now waits for the worker's bounded shutdown before checking image/file cleanup, and passed ten repeated focused runs plus all ten tests in that file. Final integrated CI remains pending.

## Required hands-on and release evidence

- Actual overview and Raspberry Pi feeds together: latency, disconnects, lighting, focus, image quality and sustained operation.
- iPhone Camo Camera setup for USB video, and an actual phone-to-laptop photo transfer on the intended network.
- Real microphone/speaker readback, interruption and echo/noise acceptance. Voice selection and subjective performance need a separate assessment.
- Physical measurement, assembly and post-repair verification with the user. OCR remains optional and unverified on this host.
- Real yaw/pitch calibration and controller acceptance, followed by the separate hardware safety prerequisites. No motor, laser, flash or electrical experiment is verified by a mock or simulation.
- Active-component and actual-MCU fixtures, complete breadboard placement validation, remaining character packs, fresh-machine packaging and a reviewed demonstration.

Runtime images, account details, recordings and personal development chronology are excluded from the public repository. The requirements in the checklist remain in scope; passing a software test does not mark a physical milestone complete.
