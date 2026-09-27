# Software verification

Ohm Path is a runnable Windows desktop development build. The complete product milestones remain open until their required physical and clean-install evidence exists. This page distinguishes working software from unverified hardware and user-environment behavior.

## Launch

On a prepared checkout, open `scripts/start.cmd`. A fresh checkout needs Python 3.12+, Node.js 22+, and pnpm 11.25.0, then `python scripts/setup.py`. Install KiCad 10 and ngspice for their respective circuit tools. Local speech also requires the separately installed whisper.cpp worker and model described in the README. Setup does not change PowerShell policy or enable hardware.

The desktop starts its own private local service and shuts it down when closed. Live help offers explicit camera selection and snapshot questions. Photo help accepts selected images and optional phone photo transfer. Spoken questions fill an editable draft; only Ask submits it. Voice playback starts disabled each launch and Listen is explicit. Turret preference records setup intent; physical actuation remains disabled.

## Implemented and verified software

| Area | Evidence | Boundary |
| --- | --- | --- |
| Circuit tools | Installed KiCad 10.0.6 exported the reviewed passive-source schematic; installed ngspice 47 produced 3.300000 V. Both passive golden fixtures matched independent reference voltages. | Simulation prediction, not a measured physical circuit. Active components and arbitrary SPICE directives are unsupported. |
| Backend and contracts | Latest local checks: 404 laptop-service tests and 16 Pi-service tests passed; two optional Windows OCR tests skipped because shell policy blocks their helper. Python lint and generated-contract consistency passed in CI. | One existing Starlette/httpx deprecation warning remains. Pi tests use simulations, not connected hardware. |
| Local vision | Seventeen synthetic backend/API tests and a production Electron regression with synthetic camera video and the real OpenCV service passed. Separate backend and UI reviews found no blocking defects. | Tracks an explicitly selected image feature. No automatic circuit connectivity, physical accuracy, electrical confirmation, or calibrated aiming claim. |
| Image reasoning | An end-to-end Photo help check identified the source and both resistors in a reviewed synthetic diagram, returned five correctly located annotations, and predicted the expected 2.5 V unloaded midpoint. | One known schematic, not a real breadboard or physical measurement. The answer stated its assumptions and did not claim measured voltage or safety. |
| Phone photos | Eight local bridge tests plus the production phone page in Chromium passed: bounded resize, explicit Send, preview, expiry and cancellation. | Actual iPhone Safari, Wi-Fi/firewall and USB live-camera behavior await device checks. The local trusted-network HTTP link is unencrypted. |
| Spoken input | Mocked draft-only capture/cancellation checks passed. Installed Whisper recognized one synthetic local question correctly on CPU. | Real microphone, room noise, speaker echo and simultaneous dual-camera behavior remain unverified. |
| Voice output | Bounded streaming, cancellation and budget checks pass offline; provider PCM transport has been verified separately. | No actor/character voice match or audible physical-speaker quality is claimed. The saved stock voice is not an exact anime performance. |
| Theme and fullscreen | Solid dark green title bar, countryside continuation, caption-control spacing and readable signpost navigation are implemented; synthetic layout checks passed. | Native Windows caption-control overlap still needs a direct window check. |

## Integrated checks

The full desktop regression run completed with 20 passes and one stale test assertion: recovery now reads ElevenLabs status without generating speech, and the test's exact action list omitted that new read. The expected list was updated; the failed test passed in isolation afterward. This was not a voice-generation or renderer failure. All 21 cases therefore have passing evidence, with the recovery case rerun separately. The explicit silent verification profile now includes local vision and phone transfer.

The post-fix **30-minute synthetic animation run passed**: 194 samples, 15 fullscreen reentries, 14 subtitle toggles and nine snapshot reviews, with zero geometry changes, layout changes, pixel mismatches or renderer errors. The test app exited successfully and its private service stopped. It made no model, audio or physical camera calls. This establishes the tested elapsed synthetic run, not real-camera or hardware acceptance.

Earlier long synthetic checks genuinely failed on a pixel mismatch after approximately 17 minutes. Same-frame diagnostic images had identical opaque masks and best alignment at zero pixels, with mostly one-level RGB differences. This supports a canvas rasterization change rather than a shifted body. The guide now requests readback optimization for its three canvas contexts. The build, accelerated phase/fullscreen checks, and 100 strict pixel readbacks also passed. The assertions were not relaxed to obtain the full-duration pass.

The integrated source passed its [Linux workflow](https://github.com/taliamekh/ohmpath/actions/runs/36282099566), including locked dependency installation, contracts, Python lint/tests, renderer build and desktop bridge tests. An older branch exposed a test race in cancellation cleanup; the test now waits for the worker's bounded shutdown before checking image/file cleanup, and passed ten repeated focused runs plus all ten tests in that file.

The known-diagram check exposed a Windows text-decoding failure before an answer could complete. The app-server protocol now explicitly uses UTF-8, independently of the Windows code page. A raw Unicode subprocess regression and all 53 existing reasoning/runtime tests passed. The real diagram request then completed in 28.77 seconds with the correct prediction and annotations. No further synthesis or physical camera capture was needed for that proof.

## Required hands-on and release evidence

- Actual overview and Raspberry Pi feeds together: latency, disconnects, lighting, focus, image quality and sustained operation.
- iPhone Camo Camera setup for USB video, and an actual phone-to-laptop photo transfer on the intended network.
- Real microphone/speaker readback, interruption and echo/noise acceptance. Voice selection and subjective performance need a separate assessment.
- Physical measurement, assembly and post-repair verification with the user. OCR remains optional and unverified on this host.
- Real yaw/pitch calibration and controller acceptance, followed by the separate hardware safety prerequisites. No motor, laser, flash or electrical experiment is verified by a mock or simulation.
- Active-component and actual-MCU fixtures, complete breadboard placement validation, remaining character packs, fresh-machine packaging and a reviewed demonstration.

Runtime images, account details, recordings and personal development chronology are excluded from the public repository. The requirements in the checklist remain in scope; passing a software test does not mark a physical milestone complete.
