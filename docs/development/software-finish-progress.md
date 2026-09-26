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

## Next tasks and open evidence

Finish interface integration; review cancellation and credit boundaries; build once the existing camera soak releases the test window; run offline end-to-end tests; verify phone photo transfer and an actual iPhone video feed when the phone app is ready. Read fresh ElevenLabs account metadata before any bounded, authorized live voice test. Record actual outcomes and leave voice identity/quality unverified unless heard and assessed.

The full original requirements remain tracked in the checklist. Physical dual-camera tests, calibrated turret acceptance, noisy-bench speech/echo tests, active-component and MCU-specific fixtures, complete breadboard placement, remaining character packs, and clean-machine packaging are not completed by these changes.
