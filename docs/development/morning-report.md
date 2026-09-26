# Ohm Path — September 26 build handoff

The original timed run was checkpointed September 26 at **12:56 p.m. Toronto**, before the revised **1:00 p.m. / 17:00 UTC** deadline. The user subsequently authorized the Photo help, camera-first interface, Frieren artwork and silent ElevenLabs setup described below. This is a runnable Windows desktop development build with a separately packaged Pi source service. It is not a physically commissioned electronics assistant or turret. The complete product requirements remain in scope; no hardware milestone is marked complete.

**Post-checkpoint update, approximately 2:40 p.m.:** Circuit lab's menu is replaced by Photo help. Camera help is the landing page; circuit and firmware tools remain available inside the expanded bench tools. Settings saves a turret preference without enabling physical output. Frieren has reference-based expressions, blink/movement and a playback-state mouth frame. ElevenLabs is privately linked, with generation disabled and no speech or preview tests. See `visual-workspace.md` for current limits and evidence.

## Launch the application

To open the reviewed application, double-click **`scripts\start.cmd`** in `C:\Users\talia\OneDrive\Documents\ChatGPT\benchmate`. This checkout already has the desktop dependencies, compiled interface, Python service, ngspice, KiCad and local speech model prepared. The launcher does not require changing PowerShell policy. Close the main window to close its local service and companion. A second launch brings the existing profile window forward rather than opening a second service.

A useful software demonstration:

1. Start with **Photo help**: choose a PNG/JPEG image, type a question, and press **Ask about these images**. This uses subscription allowance and sends only the selected images/question. No camera or turret is required. Alternatively, connect a camera explicitly in **Camera help** and choose a snapshot to review.
2. For circuit evidence, expand **Measurements and circuit tools**, create a **practice bench**, select **Divider**, and press **Run local solve**. The actual installed ngspice engine predicts A = 2.2 V and B = 1.1 V for the nominal fixture.
2. Select **Low-voltage supply**, check the practice setup declaration, and save it. Choose red B / black GND and start a practice step. Enter **0.275 V**, inspect the readback, press **I checked this readback**, then **Confirm practice input**. This is synthetic evidence, not a physical measurement.
3. Press **Diagnose**. The comparison keeps ambiguous resistor faults separate and proposes A / GND as a discriminating next test. **Review in step setup** prepares a step; it does not automatically start or confirm one.
4. Open **circuit and firmware tools** inside the expanded bench tools to prepare the logical assembly guide, analyze a pasted example firmware log, or ask the subscription investigator about recorded evidence. The investigator consumes existing account allowance only when requested. Its optional image requires selection and explicit review.
5. In **Devices**, run the aiming simulation and load/check synthetic calibration samples. These outputs are labeled as simulation or offline candidates and cannot move hardware. Historical RC/diode lab source remains preserved, but its menu was replaced at the user's request.
6. **Settings** offers turret on/off preference, reduced motion, Frieren expressions and a separate animated companion. ElevenLabs is linked locally; generation is still disabled, with no speech/preview requested.

Use a **manual supervised** session only to record readings you personally observe. Its evidence is labeled user-reported, not automatically instrument-verified. Camera and microphone access is opt-in; no physical capture was used for the automated desktop walkthrough.

## What is implemented and what remains

| Requirement | Working software and evidence | Remaining product work |
| --- | --- | --- |
| Desktop and local state | Named Electron UI, private local service, append-only SQLite evidence, restart pauses, shutdown lease, isolated companion | Clean-machine installation and hosted CI execution are not yet demonstrated |
| Subscription investigator | One bounded Astra/medium turn, four restricted tools, current evidence validation, cancellation, allowance checks, reviewed-image path; actual live proof passed | Broader adversarial and production-user trials; configuration/capability restrictions are not an OS sandbox |
| KiCad/ngspice | Native reviewed schematic preview and acceptance; resistor/DC-source graph validation; real operating-point results; failed runs contain no invented values | Broader component/model and schematic support; no arbitrary imported SPICE directives |
| Measurement and diagnosis | Signed units, explicit requests, readback/challenge confirmation, append-only corrections, context/revision rejection, heuristic fault comparisons, report export | Supervised physical diagnostic and repair-retest workflow; multiple-fault breadth and tolerance calibration |
| Spoken questions and readings | Local whisper.cpp recognition, push-to-talk, question/reading/stop routing, bound spoken confirmation, captions and optional system read-aloud; ElevenLabs credential/voice metadata linked | Real noisy microphone/speaker tests, continuous hands-free mode, echo/barge-in validation, ElevenLabs playback and direct Photo help microphone integration |
| Photo help | Independent upload/question route, native pixel review, image annotations, bounded follow-up context, no circuit fixture or model tools; one actual image API proof and offline UI replay passed | Real circuit usefulness trials, larger-image import/resizing and durable project photo selection |
| Both cameras | Explicit local overview-device selection; authenticated loopback Pi MJPEG preview through a separately prepared tunnel; bounded recent-frame buffers | Simultaneous iPhone Camo and actual Pi capture/latency/disconnect tests; user pairing and device inventory |
| Vision and meter | Geometry/target/freshness primitives and synthetic regressions; optional cropped-meter OCR candidate adapter | Actual target overlays/pose pipeline, held-out images, focus/crop validation and working installed OCR engine |
| Calibrated yaw/pitch | Two-axis bounded controller, synthetic convergence, stale/depth/target/oscillation guards, offline fit with independent held-out samples | Physical actuator driver integration, measured backlash/travel/speed/settling, live calibration and full revision handoff |
| Turret safety | Mock command receiver, authenticated bounded requests, epochs/TTL/idempotency/watchdog checks; emission always disabled | Exact parts/wiring, independent normally-off cutoff, physical kill/held-enable and safe dummy-load acceptance; no laser authorization inferred |
| Assembly guidance | Ordered logical net/component guide with user acknowledgments | Verified breadboard hole/rail/orientation placement and a real assembly/reassembly walkthrough |
| Active circuits and firmware | Educational RC and diode analyses; bounded supplied-log/board/baud analysis, possible boot/configuration faults | General active-circuit diagnosis, selected actual MCU profile, source/deployment identity and matched physical cases; no flashing |
| Animated guides | Reference-based Frieren neutral/thinking/stumped/happy artwork, blink/movement, playback-state mouth frame, separate companion, captions and reduced motion | Public asset permission, frame alignment polish, phoneme-level lip sync and actual voice playback verification; other characters remain future scope |
| Delivery and privacy | Local commits, pinned dependencies, source-only Pi bundle with manifest, local report excludes raw media and private logs | Full hardware demonstration, packaged Windows installer, recordings, clean-machine acceptance and any publication |

## Latest post-checkpoint verification

Production build passed. The photo backend worker recorded **357 passed, two skipped** and clean lint. Four targeted desktop checks passed across the visual walkthrough, manual circuit regression, crash/reload check and offline Photo help replay. Seven photo/Pi/image/turret unit checks plus four localhost-link security checks passed. The real subscription photo API returned a validated answer in **11.19 seconds**, correctly recognizing a generated blank image. Neither this proof nor the replay verifies diagnosis of a physical circuit. No speech was generated or played, and no microphone or real camera was opened. The new work has not repeated the earlier 30-minute stability run.

## Earlier timed-run verification (historical)

- Full backend suite: **348 passed, two skipped** in 20.84 seconds in the consolidated verification run.
- Desktop suite: **three passed together in 2.2 minutes**. The full walkthrough uses a real local service, actual ngspice and a **Chromium-generated camera**. It covers signed input/readback/confirmation, original-question forwarding, diagnosis, assembly, supplied firmware log, both laboratory plots, calibration candidate, aiming simulation, companion isolation, permission revocation, pause and clean exit. A reload/crash test preserved the session after reload and closed the private service after a deliberately crashed renderer. A silent speech mock rejected late readback completion after candidate replacement and showed that reading a summary cannot acknowledge a pending measurement. No speaker or microphone was used.
- Node bridge/image suite: **four passed**. An additional **two native Electron image checks** removed synthetic PNG/JPEG comment metadata while preserving decodable pixels. Build/type check, Python lint and generated-contract checks passed; `pip check` found no broken dependencies. The software CI YAML was parsed and reviewed; hosted CI has not run.
- Live subscription investigator: **passed in 49.64 seconds** using a controlled practice screenshot, the four allowed tools, actual ngspice and validated evidence links. Earlier failed attempts are documented in `investigator-runtime-proof.md`; this is not physical image interpretation acceptance.
- Local speech recognition: a synthetic spoken corpus achieved **16/17 semantic cases**; one node-identity transcription is still wrong. Median recognition time was 1.829 seconds and maximum 23.453 seconds. A separate public sample took 1.734 seconds. This is not a noisy-bench microphone test.
- Pi package: deterministic archive/member/hash checks and extracted offline controller/calibration tests passed. The package was not transferred to or executed on a physical Pi.
- **Software-only stability run passed: 30 minutes 11 seconds, 179 confirmed practice cycles and 30 actual ngspice solves.** Median cycle time was 38 ms; maximum was 274 ms. Sampled synthetic video time advanced throughout, recent-event responses stayed capped at 100 entries, and the ledger reached sequence 928. The first nine-second harness attempt checked before the synthetic camera decoded a frame; the harness wait was fixed before this successful run. This run began before the final speech, permission and calibration-display refinements; the final build is covered by the shorter desktop regressions, not a second complete 30-minute run. Coarsened JavaScript heap readings were not treated as reliable memory measurements.

The final desktop lifecycle check also verified that a second launch using the same profile exits cleanly and leaves the first window's session intact. This avoids two independent local services writing the same evidence database. There is one existing Starlette test-client deprecation warning. The two skipped checks concern optional Windows OCR. **All physical tests remain pending.**

## Pi source delivery

The reviewed source bundle is `runtime\pi-package\ohmpath-pi.zip`, with `MANIFEST.sha256` and a README inside. Its SHA-256 is `e8376247fc8e2515ce0356336450d37a83c71e61516cd7fd07baf03867e57e1b`. Rebuild with `.venv\Scripts\python.exe scripts\package-pi.py`. See `pi-deployment.md` and `pi-controller-handoff.md` for the mock service, controller APIs and opt-in camera process.

The extracted `python3.12 -m ohmpath_pi --demo 390 200` command is simulation only. The camera process requires compatible Raspberry Pi OS/Picamera2, an explicit camera flag and a fresh per-launch token. The desktop expects an existing separately authenticated SSH tunnel. No SSH pairing, GPIO/PWM driver, boot-start service, firmware flash, motor movement or laser operation was performed.

## What needs your attention

1. **Hardware identity and inspection:** confirm the actual Pi, MCU, servo/driver, supply, laser module specifications, wiring/pin map, turret mechanics and camera ribbon clearance. The current source cannot drive a real actuator.
2. **Supervised commissioning:** establish the Pi host identity and Ethernet/SSH link, test both real cameras, then review the mechanical/electrical safety design. Motor-only tests require the laser physically disconnected. Independent cutoff/dummy-load acceptance comes before any laser work.
3. **Real interaction tests:** run microphone/speaker/noise and signed-measurement readback trials; verify the OCR engine after a user-controlled installation if desired. Never trust an ASR/OCR candidate without its readback.
4. **Product choices/assets:** choose the actual MCU fixture and review Frieren's new reference-based expression artwork. ElevenLabs is linked with the selected Sarah voice and a 1,000-credit restricted key cap; no generation or preview was requested. Approve later voice playback testing when ready. Other characters and public asset permission remain future decisions.
5. **Publication:** changes are committed locally. GitHub authentication/privacy and a release review remain unresolved, so no push or upload was performed. Private runtime reports, recordings, historical `outputs/` and generated archives remain outside Git.

## Run, allowance and interruption record

The original run began **01:37:21 Toronto**. At 01:42:18, the coordinator's display-off command caused Windows Modern Standby; the machine returned at 10:31:45. **The overnight run did not continue.** Work resumed under the user's revised 1 p.m. deadline. No further display/power/sleep command was issued.

**The one authorized banked reset was redeemed once** at approximately 11:37, after a fresh official reading showed 2% remaining. It succeeded; banked resets decreased from three to two. The attempt, outcome and fixed idempotency key are recorded privately in `runtime/overnight-run.json`. No second reset, purchase, top-up or paid API fallback was used.

Automatic approval review rejected the unattended Tesseract installation before execution with **`blocked by policy`**. No retry or bypass was attempted. Existing PowerShell policy also prevented the optional Windows OCR helper. OCR remains unavailable/unverified; this did not prevent typed or spoken candidate entry.

Next user-dependent work is a supervised hardware/device inventory and real-camera acceptance session, followed by physical-driver and breadboard-placement work once the required identities and measurements are known. Voice testing remains deferred under the user's explicit instruction. Requirements and milestone checkboxes remain unchanged until their acceptance evidence exists. The original unattended run ended at the revised deadline; later work above followed fresh user authorization. Launching the application does not start an investigator turn.
