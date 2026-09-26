# Nonhardware integration progress — September 26, 2026

This run began at 22:09 UTC after the user connected an iPhone and authorized completing the software apart from hardware integration. There is no new overnight deadline or power-management task. Motors, laser emission, board flashing, and electrical experiments remain excluded.

## Authorization and spending

The user authorized **at most 10,000 ElevenLabs credits** for thoughtful use and testing, replacing the earlier no-generation instruction. No purchases, upgrades, automatic top-ups, or API reasoning fallback are authorized. The earlier single Codex usage reset was already used; no further reset is permitted. The private, ignored `runtime/software-finish-budget.json` records provider attempts and accounting. One short synthesis transport check completed under a **100-credit maximum reservation**. Delayed fresh account metadata showed a **17-credit usage increase**. The conservative reservation remains recorded. No audio was played or retained, and generation was disabled afterward.

The user selected the **English dub** as the intended Frieren performance. The currently saved stock voice is not an exact match. Presentation prompts can shape phrasing but cannot make a stock voice identical to the actor. Voice matching remains explicitly unverified; do not spend the allowance repeatedly previewing an unsuitable voice.

## Implemented and under integration

- Opt-in phone photo transfer: expiring QR pairing on a selected private network, authenticated bounded uploads, preview on the phone, explicit Send, then explicit Ask on the laptop. The bench API remains loopback-only. Trusted-network HTTP is unencrypted and disclosed.
- Standalone local spoken-question transcription: a bounded in-memory recording fills an editable question draft. It cannot submit a question, create a measurement candidate, or confirm a reading.
- Optional ElevenLabs PCM streaming and playback: fresh allowance/overage checks, conservative credit reservation, explicit Listen actions, per-launch character budget, cancellation, and no paid fallback. It starts disabled each launch.
- Shared explanation style follows calm, spare English phrasing while keeping evidence, exact quantities, readback, and safety language literal.
- Camo Studio installed from its official distribution. Windows enumerates the connected Apple iPhone. Actual iPhone video is still pending Camo Camera on the phone and live-feed verification.

## Recorded checks

- Phone bridge: 8/8 offline localhost-adapter tests passed, including expiry, restart, slow uploads, and callback cancellation races.
- Voice adapter/player: 9/9 new offline tests plus 10/10 existing connection tests passed, including the launch credit ceiling and duplicate charged-request rejection.
- Local question endpoint: 5/5 tests passed with mocked transcription, including authorization, malformed/non-ASCII base64, and unchanged measurement state/evidence.
- Shared presentation and both reasoning prompt paths: 40/40 targeted offline tests passed.
- Build passed. Combined desktop unit and selected speech/backend checks passed: 46 Node tests and 143 Python tests, followed by the two added credit tests above.
- The new photo voice interface test passed with fake microphone/playback and provider IPC: draft-only transcription, cancellation, navigation cleanup, explicit Ask/Listen, and Stop. Real microphone/speaker quality remains unverified.
- All five selected interface checks passed together in 2.1 minutes: late camera snapshot cleanup, phone transfer controls, photo replay, spoken question/playback controls, and workspace retention. The existing replay fixture was updated for the additive phone IPC; its first run rejected those newly introduced mock actions, rather than indicating a production failure.
- The actual production phone page/bridge passed a localhost Chromium test: blob-backed preview, 3000×1000 PNG resized to 2400×800, no send before the button, bounded JPEG receipt and token-fragment removal. Review caught and fixed a CSP rule that initially excluded blob image previews. This does not establish iPhone Safari or LAN/firewall behavior.
- The installed Whisper CPU worker exactly recognized a synthetic local system-voice recording: “Where should I check the ground connection?” Recognition took 1.64 seconds (2.95 seconds including startup). The worker exited and the synthetic WAV was deleted. This does not establish microphone, room-noise or echo performance.
- Actual ElevenLabs streaming returned 162,726 PCM bytes in 36 chunks for one short sample. Generation was disabled afterward. This proves the selected stock voice's transport, not its identity, audible quality, or an end-to-end physical speaker test.
- The attempted 30-minute **synthetic camera** run reproduced a raster mismatch at 17m44s after nine fullscreen cycles. It failed; all synthetic tracks and the private service stopped. The failure is preserved in private runtime evidence, and an accelerated pixel comparison is investigating it. No 30-minute pass is claimed.

## Integration checkpoint and publication request

At 23:05 UTC, the integrated renderer build, generated-contract check and full Python lint passed. The full Python suite passed **401 tests**, with two optional Windows OCR checks skipped because the local execution policy blocks the helper. All **48 desktop bridge unit tests** passed. Voice readback and Photo help voice regressions passed with simulated audio. The camera-focus regression exposed a paused-preview bug: a visible captured-image question was treated as inactive. Keeping the image review active fixed it; the regression then passed in 47.6 seconds. Fullscreen includes its own Stop speaking control.

The user now explicitly authorizes progressively pushing reviewed, named feature branches and updating main when appropriate. The GitHub repository is public and authenticated with push permission. Existing unpublished local history contains private account/progress notes, so it will remain local. Separate public branches will carry reviewed source and sanitized technical documentation; no force-push, account notes, credentials, recordings or private runtime artifacts are included.

## Evening work window checkpoint

The current 90-minute continuation window started at **2026-09-26 23:04:14 UTC** and stops starting work at **2026-09-27 00:34:14 UTC** (8:34 p.m. Toronto). The supported heartbeat is configured for this deadline. No power or display commands are authorized or used.

- The native title bar and renderer strip now use solid dark green. Fullscreen content leaves space beneath the native caption controls. A reviewed generated countryside continuation replaces the disconnected main-panel scenery; the original artwork is preserved. Build and synthetic fullscreen/layout checks pass. Native control overlap still needs an actual window check.
- Installed KiCad 10.0.6 exported the reviewed passive-source schematic; ngspice 47 simulated the imported circuit at **3.300000 V**. Golden divider and loaded-divider fixtures also produced the expected voltages. These are actual software-tool runs, not electrical measurements. Export output is bounded while the process runs.
- Opt-in local OpenCV point tracking is implemented for the selected camera view. It follows an explicitly selected textured feature, clears lost or invalid results, and separates image position from electrical or aiming evidence. Frames stay local; the separate Ask action sends a selected snapshot to the existing reasoning route. Backend/API review passed; 15 synthetic vision tests passed, and the combined vision/circuit selection passed 46 tests. The production Electron overlay test passed with synthetic video and the real local OpenCV service, including transport failure, reselection, fullscreen mapping, and shutdown cleanup.
- The animation diagnostic now saves same-frame pixel evidence on any mismatch. An accelerated 100-readback/nine-fullscreen-cycle test passed twice, and a one-minute real-time diagnostic passed. These do not replace the previously failed 30-minute run; a fresh full-duration synthetic run is pending after the complete desktop suite.
- Computer Use returned a physical Escape stop during the attempted laptop-camera check. Screen control stopped immediately. The subsequent heartbeat continues source work and app-internal synthetic tests only; real laptop-camera proof remains pending. No private camera frame was published.
- Reviewed history is published incrementally through the authenticated GitHub connector. `codex/bench-and-pi-services` and `codex/desktop-workbench` are published; `codex/photo-help-and-character` is in progress. Main remains unchanged while final integration is under review. Original local history and private progress/account ledgers remain local.
- No further voice generation, usage reset, hardware operation, or spending occurred during this continuation.

At 23:39 UTC, the full Python suite passed **417 tests**, with two optional OCR checks skipped. Lint and generated contracts passed. The full desktop run passed **20 of 21** tests; the single failure was a stale exact request list in the renderer recovery test after adding a silent ElevenLabs status read. Correcting that expected list made the targeted recovery rerun pass. A fresh 30-minute synthetic animation diagnostic began at approximately **23:37:44 UTC** with same-frame mismatch capture. No additional Electron test window is opened while it runs.

The local vision integration is committed as `c81972b`. A CI-only timing race in an older investigation cancellation test is fixed with a bounded worker join; the focused test passed ten times and its full file passed ten tests. The public photo-help branch's Linux workflow passed. The countryside branch is published, and phone/voice publication is in progress. Main remains unchanged.

Next: finish the new 30-minute synthetic animation diagnostic, publish the integrated verification branch, review final CI/privacy, and consider main when the reviewed result is ready.

## Next tasks and open evidence

Publish the reviewed software in coherent branches after the privacy review. Continue investigating the long animation mismatch with accelerated fullscreen phase sampling and retained pixel evidence. Verify actual iPhone photo transfer/video when Camo Camera is ready. No additional synthesis is necessary for transport verification. Voice identity/quality remains unverified unless heard and assessed.

The full original requirements remain tracked in the checklist. Physical dual-camera tests, calibrated turret acceptance, noisy-bench speech/echo tests, active-component and MCU-specific fixtures, complete breadboard placement, remaining character packs, and clean-machine packaging are not completed by these changes.
