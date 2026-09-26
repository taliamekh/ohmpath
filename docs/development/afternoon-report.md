# Ohm Path afternoon handoff

September 26, 2026. Authorized work window: 3:18:17–4:48:17 p.m. Toronto (19:18:17–20:48:17 UTC). The detailed work record is [afternoon-progress.md](afternoon-progress.md).

## What changed

- The logo is the Omega-shaped path alone. Its center is empty, with no cottage, landscape interior, circuit traces or nodes. Historical artwork remains preserved and unused.
- The countryside background, cottage, winding trail and wooden navigation signs use reviewed PNG artwork. Six Frieren poses include the requested smug and weary expressions. Local ear, arm and clothing motion holds the face in place; the old periodic whole-body image swap is removed. Reduced motion is supported. This is a raster puppet, not a pixel-identical tracing or phoneme-level lip sync.
- Explanations use calm, reserved wording and light dry humor. This character style does not alter quantities, evidence, measurement acceptance or safety decisions.
- Camera help has Full screen, bottom-right Frieren, optional subtitles and a collapsible snapshot-question drawer. The preview stays mounted while reviewing a snapshot. Subtitles show the actual answer or pending measurement readback without audio; they cannot confirm a measurement.
- Photo help accepts PNG/JPEG circuit pictures and diagrams without a camera or turret. Phone-size sources are resized locally and metadata is removed. Paste image explicitly reads image pixels only. Pictures and completed replies survive page changes in memory; Clear workspace releases them. Quitting/reloading discards that temporary workspace.
- Late photo selections, cancelled answers and obsolete troubleshooting replies are discarded. Circuit/photo connection setup can be cancelled promptly. Pi preview failures clear old frames and require reconnect. A renderer error offers manual recovery without showing raw exception text.
- Compact navigation retains accessible names and usable camera/photo controls. Mock turret commands now enforce minimum step spacing and consistent retry identity.

## Launch and use

The updated desktop was relaunched; the visible window title is **Ohm Path**. To open it again, double-click [`scripts/start.cmd`](../../scripts/start.cmd) in this prepared checkout.

Choose **Photo help**, add or paste a circuit image, type a question and press **Ask about these images**. Only Ask sends the selected images through the existing signed-in subscription. In **Camera help**, explicitly connect a camera, choose a view and use **Ask about this view** to select a snapshot for review. **Full screen** hides navigation; Escape exits. **Subtitles on/off** works with audio off. **Pause previews** stops capture.

The expanded **Measurements and circuit tools** preserve KiCad/ngspice, measurement readback/confirmation, logical assembly guidance and supplied firmware-log troubleshooting. Practice inputs and simulation results retain their labels. The historical Circuit lab designs remain in the repository, but Photo help is the menu destination.

## Actual verification

- The explicit silent verification profile passed: generated contracts, lint, 208 Python checks, production build, 20 bridge checks, native metadata/upload/paste checks and all 12 desktop walkthroughs (5.8 minutes). Two optional OCR checks skipped. One upstream test-client deprecation warning remains.
- Follow-up runtime cancellation: 25 offline tests passed. An extra pasted-image ownership/capacity check passed. The camera question-label follow-up passed after rebuilding, including a retained hidden Photo help workspace alongside the camera drawer.
- A thirteenth desktop scenario passed separately (39.5 seconds): both synthetic camera paths display together, snapshots use the selected source, fullscreen/layout changes retain the overview stream, Pi disconnect preserves overview, and leaving Camera help stops the stream. The silent profile now includes this scenario.
- Its strengthened follow-up also passed (38.5 seconds): decoded snapshot pixels match the selected synthetic camera's distinct color pattern, in addition to the correct source label.
- Native image checks reduced a synthetic 10,046,853-byte phone photo to 1,485,271 bytes, verified all eight JPEG EXIF orientations and removed synthetic metadata. Clipboard tests used fake clipboard objects, never the user's clipboard.
- Character checks kept central face pixels fixed across the former 6.8-second jump interval, observed changing outer pixels, rendered all six poses and verified reduced-motion freeze.
- The longer synthetic-camera/animation run **failed its exact face-pixel check after 17 minutes 31 seconds**, following a fullscreen re-entry. It recorded 94 advancing video samples, nine fullscreen cycles, eight subtitle toggles, five snapshot reviews and no page/console errors. This is not a 20-minute pass. The old report did not record canvas geometry at the mismatch, so its cause cannot yet be classified as a layout change or an animation defect. The private test service exited; no physical or voice action occurred.
- A separate three-minute diagnostic passed with 12 advancing samples, six fullscreen cycles, five subtitle toggles, three snapshot reviews, stable face pixels and no geometry changes. Synthetic tracks and its private service stopped. A fixed-viewport phase diagnostic also passed: 14 sampled paints spanning 39 simulated minutes retained one face hash while outer pixels changed. This is accelerated phase sampling, not 39 minutes of real elapsed stability. Neither short diagnostic clears the failed long run.

The earlier [investigator runtime proof](investigator-runtime-proof.md) already passed image transport, four restricted tools, actual ngspice and validated evidence links. No duplicate live model turn was run this afternoon. That earlier input was a controlled practice screenshot, not physical circuit interpretation acceptance.

To repeat the silent automated profile: `.venv/Scripts/python.exe scripts/verify.py --no-voice`. Add `--list` to inspect its exact commands without executing them. Default verification includes separate voice mocks and was not used during this window.

## Pi code and remaining limits

The source-only Pi bundle is `runtime/pi-package/ohmpath-pi.zip`, SHA-256 `33e5b8b1546ee3c6aa0db6b892ac2ef8642e8117808fdf537957d4bbdf832fb9`. It contains the bounded mock controller, calibration code and separately opt-in camera server. It has not been installed or run on a physical Pi. See [Pi deployment](pi-deployment.md).

No GPIO/PWM motor driver, laser enable path, physical calibration, real dual-camera verification, SSH pairing, firmware flash or electrical experiment was performed. The turret switch saves setup intent and cannot enable physical output in this build. All physical tests and complete-product milestones remain pending.

ElevenLabs remains linked privately with generation disabled. No voice playback, preview, synthesis or microphone test was run. Spoken Photo help and verified ElevenLabs answer playback remain unfinished integration work. Existing local speech/readback features were preserved, without retesting voice.

## What needs the user's attention

1. Review the new artwork and layout. Public asset/voice permission and release review remain unresolved; nothing was pushed or published.
2. Supply/confirm the actual Pi/MCU, servo/driver, laser module, supply, wiring and mechanical details before a real actuator driver or commissioning can be completed.
3. Supervise real camera/network tests and later motor-only calibration with the laser physically disconnected. Physical interlocks and electrical acceptance are separate gates.
4. Authorize voice playback testing when ready and try real circuit photos. Current camera helpfulness and noisy-bench interaction are not physically verified. Optional OCR remains unavailable here.
5. The long fullscreen/animation pixel check requires a fresh measured run after its mismatch is explained. Short passing tests do not replace that failed long-run result.

The single previously authorized reset was used in the earlier run. **No additional reset was attempted this afternoon.** No purchase, paid upgrade/top-up, paid API fallback, power/display/sleep command or hardware operation occurred. Changes are committed locally; private evidence and generated archives remain outside Git.
