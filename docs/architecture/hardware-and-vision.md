# Hardware, cameras, and physical guidance

Status: build design, not a report of working hardware. Updated 2026-09-26.

This plan supports the full Ohm Path experience: a live circuit view, zoomed explanations, measured results, assembly guidance, and an optional physical pointer that refers to the same thing as the screen. Hardware safety and calibration are release gates, not model judgments.

## Hardware baseline and existing work

| Item | Selected use | Evidence and remaining verification |
| --- | --- | --- |
| Windows laptop | UI, vision, OCR, circuit tools, session state, voice and model connection | Main application host; no circuit inference on the Pi. |
| Raspberry Pi 5 | Camera capture and bounded turret controller | Direct Ethernet to laptop. Confirm power supply, cooling, OS image, available connections and camera cable before setup. |
| Camera Module 3 Wide | Moving close-up camera mounted above the laser | R11 saved geometry places the optical axes 24 mm apart vertically at neutral. This is a CAD dimension, not a calibrated transform. |
| iPhone | Fixed overhead circuit view by default; selectable close-up/meter view | Camo Camera on phone and Camo Studio on Windows, connected by USB. Exact phone model, cable and available resolution still require confirmation. |
| KAIWEETS HT118A | Physical measurements | Read its display with a camera or accept spoken/typed readings. The manufacturer page documents no USB/Bluetooth export; do not invent a digital-meter connection. |
| Yaw motor and base | MG996R with R10 adjustable base | Seven functional print pieces. CAD checked; physical fit, strength, cable path and loaded motion unverified. |
| Pitch mount | Retained MG90/MG90S arrangement, R8 open-top replacement plan | R8 resolves the earlier closed-slot cable assembly problem in CAD; real assembled fit is not yet established in the records. |
| Camera arm | R11 replacement arm and four 4 mm spacers | R11 combined print plate contains twelve functional pieces including the unchanged R10 base parts. Real fit and cable sweep unverified. |
| Laser holder | R9 revised 6.35 mm nominal grip | Earlier 6.8 mm holder failed retention; 6.4 mm coupon fit informed R9. R9 physical grip remains unverified. Laser class, power and electrical interface are unknown. |

The mechanical status above comes from the existing local records `outputs/turret/Physical-Fit-Feedback.md`, `outputs/turret/R10-MG996R-Base/READ-ME-MG996R-BASE.md`, `outputs/turret/R11-Camera-Wide/READ-ME-CAMERA-AND-BASE.md`, and `outputs/turret/R11-Camera-Wide/R10-BASE-ASSEMBLY.md`. These preserved legacy files are not assumed to be included in a clean repository clone. Curate the final manufacturing package separately after physical validation; do not rename or discard existing revisions during software setup.

The Pi 5 requires a standard-to-mini camera cable: camera-side 15-pin to Pi-side 22-pin. Connect the ribbon only with power disconnected. [Raspberry Pi camera installation](https://www.raspberrypi.com/documentation/accessories/camera.html)

## Network and camera transport

The laptop keeps its ordinary internet connection for Codex and ElevenLabs. The Pi uses a separate direct Ethernet link; it does not need school Wi-Fi access for normal capture or control. Do not bridge this link onto the school network or enable connection sharing by default. Internet restrictions on the laptop can still affect cloud reasoning and speech.

During setup, inspect occupied adapter subnets and choose a non-conflicting private IPv4 pair. Configure no default gateway or DNS on that private link, preserving the laptop's internet route. Keep explicit IP configuration as the reliable path; optional discovery must not become a dependency. Confirm the laptop Ethernet port or adapter is available. A normal Ethernet cable is not assumed to power the Pi.

The Pi camera/control services bind to Pi loopback only. Reach them through SSH port forwarding over the direct Ethernet adapter, with the Pi host key explicitly verified and pinned during pairing. Both laptop forwarding listeners also bind to loopback. Permit SSH on the bench adapter only for the paired laptop; use a dedicated restricted device credential, never copied Codex/ElevenLabs credentials. A changed host key is an error requiring review, not an automatically accepted replacement. The laptop backend is the only application client; the desktop renderer cannot send raw actuator commands. No internet-exposed camera endpoint or public application listener. [OpenSSH forwarding documentation](https://man.openbsd.org/ssh)

Control and video use **separate underlying SSH/TCP connections**, not merely two channels multiplexed over one connection. Disable shared-connection reuse for these transports so a queued video frame cannot create a shared stream backlog ahead of stop/status traffic. Bound application and socket buffers, use explicit connection health checks, and verify behavior under congestion. Separate connections reduce coupling but do not replace the independent physical fail-off mechanism. [OpenSSH connection-sharing settings](https://man.openbsd.org/ssh_config)

### Pi capture decision

Use Picamera2 in a dedicated process. Send independently decodable JPEG frames over a bounded binary WebSocket inside the video tunnel; send control and status through the separate control tunnel. Start benchmarking at 1280 x 720 and 15-20 frames per second. Permit one frame in flight plus one replaceable pending frame; drop old work instead of building a video backlog. The receiver also keeps only the newest eligible frame. If transport buffering exceeds the frame-age limit, invalidate the stream and reconnect disarmed rather than treating old images as current.

Each frame has a header with camera ID, frame ID, capture timestamp, timestamp uncertainty, sensor mode, crop, resolution, orientation, lens setting, exposure, and calibration revision. An authenticated snapshot request captures additional detail for a component label or meter. A mode switch is visible to the UI and suspends spatial guidance until its mapping is valid again. Prefer a higher-resolution main stream plus lower-resolution preview where the measured configuration allows it; never disguise a frozen preview as live video.

Picamera2 provides software JPEG encoding. On Pi 5 its H.264 and MJPEG codecs also use software, so the design does not assume a hardware H.264 encoder. Profile CPU load, temperature and frame age with motors and control traffic active. If JPEG cannot meet the measured budget, replace the transport adapter with a low-latency H.264 pipeline while keeping identical frame/state contracts; do not silently sacrifice OCR detail or controller responsiveness. [Picamera2 manual, video encoding](https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf), [Raspberry Pi network streaming](https://www.raspberrypi.com/documentation/computers/camera_software.html)

### iPhone capture decision

Use the Camo virtual camera through the normal Windows camera capture adapter. The fixed overhead phone maintains circuit context while the Pi camera pans or tilts. Users can instead aim the phone at the meter, but Ohm Path must then show that overview coverage is unavailable. The application supports both feeds and a source selector; it does not pretend one camera can see the board and a separately placed meter simultaneously.

Camo explicitly supports iPhone-to-Windows over USB and recommends USB for its latency and stability. Check the available tier's resolution and focus controls during setup before deciding whether any paid upgrade is justified. No custom iOS application is required for the first complete build. Keep the camera adapter replaceable for a future native phone stream. [Camo setup](https://camo.com/support/camo/camo-getting-started), [Camo virtual-camera use](https://camo.com/support/how-to/use-iphone-as-webcam)

## Vision: claims, not guessed connectivity

The local Python/OpenCV pipeline owns undistortion, fiducial detection, board registration, stable-region tracking, display crop extraction and change detection. The model receives selected frames and structured observations when relevant, not every preview frame. A new frame is not automatically a new electrical fact.

Record observed component labels, body outlines and wire endpoints with evidence and confidence. Hidden endpoints, occluded holes, ambiguous resistor bands and uncertain pin orientation remain unverified. Prompt a close-up, a user click, a continuity test or a label confirmation when needed. Visual recognition can suggest a connection; it cannot certify electrical continuity inside a breadboard.

Assembly mode uses a selected breadboard layout with explicit rail breaks, row numbering, pin maps and component orientation. A user-approved anchor map connects semantic terminals to physical holes. It must not convert a vague model sentence such as "move that wire left" into a physical instruction. All proposed edits identify source hole, destination hole, component/terminal and required power state; each edit changes the circuit revision and requires verification.

The authoritative target is a semantic ID such as a component terminal, test point or assembly hole. The UI creates its own screen coordinates from that target and the current frame transform. The pointer controller resolves the same ID through an independently validated physical map. The model is never the source of servo angles or trusted pixel coordinates.

## Calibration and moving-camera geometry

Calibration is persisted by camera identity and configuration, with measured error and validity limits. Use OpenCV intrinsics/distortion calibration and fiducials on a rigid matte board carrier. Calibrate the actual sensor mode, orientation, crop and lens setting. A wide lens is useful for coverage but does not make edge pixels geometrically trustworthy without correction. [OpenCV camera calibration](https://docs.opencv.org/4.13.0/dc/dbb/tutorial_py_calibration.html), [OpenCV fiducial functionality](https://docs.opencv.org/4.13.0/d9/d6a/group__aruco.html)

Calibration steps are:

1. Measure the carrier and place multiple well-spaced fiducials around the usable board area. Save the board layout and coordinate convention; millimetres belong to the physical plane, pixels to a named frame.
2. Collect calibration images, estimate intrinsics/distortion, then evaluate separate held-out images. Save numerical residuals and rejected observations, not only a "calibrated" checkbox.
3. Focus at working distance, confirm image sharpness, then lock focus for pointing/OCR. Refocusing, changing lens/crop/resolution, or remounting the camera invalidates the affected calibration until checked again. Picamera2 exposes autofocus and manual lens controls. [Picamera2 manual, autofocus controls](https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf)
4. Have the user confirm a sample of labelled holes/terminals with the laser disconnected. Derive the board-to-camera pose for each usable frame and reject insufficient/degenerate marker geometry.
5. Establish the turret's allowed travel and camera-to-laser relationship with emission disabled first. Only after the separate laser safety gate passes may a supervised matte-target alignment test establish the actual beam map. R11's 24 mm CAD separation alone does not solve parallax.
6. Measure held-out target accuracy across the working area and through repeated approach directions. Include backlash, flex, focus drift and servo repeatability. A board-plane transform is not valid for arbitrary raised components or targets at different heights.

The Pi camera moves with the laser. Therefore **every turret movement invalidates its previous board pose**. This does not require rebuilding the static lens/camera-to-laser calibration after every small step: retain those verified parameters while acquiring a new per-frame board pose. Move with the beam off, wait for motion to settle, acquire fresh frames, resolve board pose and recheck target validity before any permitted indication. MG996R/MG90S command pulses are not position feedback; a completed command does not prove that the turret arrived. The fixed phone view can retain overall context but cannot substitute for an unverified Pi-camera-to-beam transform.

Unexpected board movement, loose mount, camera disconnection, missing fiducials, excessive residual, uncertain target height, expired frame or unexpected scene motion cancels the pointing request. Show "reacquiring position" when only per-frame pose is stale, and "recalibration needed" when the underlying lens/mount/beam map may have changed. Do not increment the static calibration revision for every normal fresh frame. The screen may continue showing a clearly marked last-known view, but cannot silently reuse it for a new physical action.

Initial physical pointing is to sufficiently large matte labels adjacent to the circuit, with an on-screen leader to the exact terminal. Demonstrated region-level accuracy must not be advertised as 2.54 mm breadboard-hole accuracy. Direct terminal-level pointing is a later acceptance level only if repeatability, geometry and surface safety support it.

## Yaw/pitch control with a calibrated aiming crosshair

The application will explicitly drive **both yaw and pitch**. The user's crosshair approach is the selected control strategy: locally align the predicted beam location with a known target. It avoids asking the AI to inspect successive frames or choose motor adjustments. In this section, "crosshair" means a calibrated prediction of where the beam would meet the approved target plane, not an assumed mark at the camera's centre.

Use three distinct on-screen markers:

- **Target marker:** the selected semantic terminal or nearby safe matte label, projected into the current frame.
- **Predicted beam crosshair:** the intersection of the calibrated beam ray with the known plane, projected into that frame. Label it "predicted" whenever the laser is off or no reliable spot observation exists.
- **Observed spot marker:** a separately styled marker only when an actual spot is confidently detected during an already permitted stationary indication. Never manufacture this marker from a servo command.

The 24 mm nominal camera/laser separation means a permanent centre crosshair will not reliably represent the beam at every distance. Calibration estimates the physical ray relative to the camera; fresh board pose supplies the plane distance and orientation. Invalid ray-plane geometry, a raised/non-planar target or missing pose removes the aiming prediction and prevents actuation. The user can see the camera move while the local controller keeps the semantic target registered to the board.

The deterministic control cycle is:

1. Resolve the approved target ID against the current board map and revisions. A user click may select a target, but only after reversing UI crop/zoom/rotation and validating the resulting physical location. Model-generated pixel coordinates are not actuator commands.
2. With emission disabled, track the board anchors and target locally. Compute pixel error between the target marker and predicted beam crosshair in the same undistorted camera frame.
3. Convert that error into a small yaw/pitch correction using a measured local image Jacobian or validated interpolation table. Calibration uses bounded motor-only movements to learn the sign, scale and coupling of both axes. The controller limits each step, overall velocity, allowed travel and iteration count; it refuses singular or poorly conditioned geometry.
4. Move both axes as needed with the beam off. Account for measured backlash/approach direction, wait for settling, then reacquire a fresh frame and board pose. Servo commands are not proof of arrival; the updated camera geometry closes the loop.
5. Repeat until the error stays inside the calibrated deadband for a stable interval and independent validation shows the requested target is achievable with margin. If it oscillates, times out, loses tracking, detects motion/occlusion or exceeds travel, stop and show why.
6. Only then may the separate safety supervisor accept a short stationary indication. If allowed, an observed spot verifies the prediction; disagreement immediately disables emission and invalidates the affected calibration. Any further motor correction requires beam-off first.

Run target tracking, geometry and the image-based yaw/pitch loop in the laptop bench service, independent of cloud reasoning latency. The trusted device adapter sends bounded step commands to the Pi; the Pi independently enforces physical limits and emission state. Do not call the model between correction steps. The fast video loop and slower move-settle-reacquire loop are separate; update rates and settling times come from physical tests rather than a claimed 30 Hz hobby-servo feedback rate. Keep all raw motor units, limits and calibration functions behind the Pi/controller adapter; public application commands use semantic targets. Publish the canonical `aim_state` from [shared contracts](contracts.md), including the current frame ID and prediction/observation distinction.

Acceptance includes a laser-disconnected replay/simulator, a motor-only live crosshair convergence test, and finally supervised held-out target validation after the laser gate. Test corner and centre targets, different approach directions, changed depth, lost markers, duplicate requests, moving boards and a stuck axis. A convincing crosshair animation alone is not evidence of physical pointing accuracy.

## Meter readings and spoken results

HT118A observation uses a registered LCD crop and reads the full tuple: signed value, decimal position, unit prefix, mode, range/resolution if visible, overload indicator and stability interval. A blank display or `OL` is not zero. A value without an identifiable unit or relevant meter mode is not accepted as a measurement. Manufacturer accuracy is range-dependent; use the actual mode/range when constructing an uncertainty interval. [HT118A specifications](https://kaiweets.com/products/ht118a-digital-multimeter)

The UI keeps a pending measurement request with its probe endpoints, required mode, permitted power state and circuit/firmware revision. OCR, typed text and final speech transcripts all create **measurement candidates**, not independent truths. Confirmation binds the selected value to that pending request. Conflicting OCR and spoken readings stay visible and trigger clarification. Probe position remains unverified unless confirmed by the user or suitable evidence; seeing digits alone does not verify where they were measured.

A stable OCR sequence can reduce confirmation friction only after the acceptance tests justify it for the configured display and conditions. Until then, read back important signs and units: "negative 0.12 volts between node A and ground—is that correct?" The details of speech capture and interruptions are in the voice design.

The first physical circuits use current-limited, low-voltage bench supplies. Resistance/continuity tests require power-off confirmation and relevant discharge checks. Do not ask users to move a current-range meter directly across a supply; the initial fixture tests avoid that measurement. No mains troubleshooting is included in the automatic test executor.

## Pointer controller and independent fail-off

The default state is disconnected or disarmed, with laser emission electrically disabled. Visual-only Ohm Path remains fully useful when the pointer cannot be enabled. A speech command, model output or saved session can never arm the hardware.

Before any emission, verify the actual laser's manufacturer information, wavelength/class/power, electrical driver, secure retention, constrained beam path and suitable matte target/backstop. The project adopts a Class 1 or Class 2 visible-light indication design; any unknown or higher-class module stays disabled pending a different qualified safety design. Classification alone is not a complete safety assessment. Health Canada warns against direct viewing and reflective targets. [Health Canada laser guidance](https://www.canada.ca/en/health-canada/services/health-risks-safety/radiation/everyday-things-emit-radiation/laser-products.html)

Required controls are:

- A reachable physical kill/disarm switch cutting laser power independently of Windows and Pi software.
- A normally-off driver with an **independent hardware timeout** that requires fresh valid enable pulses. A stuck-high GPIO or crashed Pi process must not leave the beam on. Do not generate these refresh pulses with an autonomous/free-running PWM or DMA waveform that could continue after its authorizing process stalls. Each refresh must depend on fresh valid local safety state; the hardware cuts power when refresh stops. Exact circuit and component ratings cannot be selected until the real module and available hardware are identified.
- A local Pi supervisor owning maximum permitted travel, speed, dwell, beam-enable conditions and command expiry. The desktop cannot override these limits.
- Separate hardware-safety states `disarmed`, `ready`, `moving`, `settling`, `indicating`, and `fault`. These are distinct from the shared contract's aiming-progress phases: `aligned` does not mean physically armed or emitting. Emission is allowed only in `indicating`, after verified settling, with the local physical enable held and a short, non-renewable indication request. Continuous autonomous illumination is not the initial design.
- Beam off for motion, probe placement, hands/occlusion, changed board, missing calibration, old frames, stale heartbeat, communications loss, service restart or any fault. Camera-based hand detection is only an additional veto, never the sole safety interlock.
- Commands carrying `command_id`, bounded validity, current revisions and an approved target ID or a narrowly authorized internal motor step. Reject stale actuation requests. A duplicate command ID returns its existing result without moving or emitting again; acknowledgement states are `accepted`, `rejected`, `completed`, or `fault`. Unknown outcomes are reconciled while disarmed, not blindly retried. Reconnection never replays an old action or re-arms the laser.

Use the shared envelope fields `schema_version`, `session_id`, `event_id`, `sequence`, `occurred_at`, `circuit_revision`, `firmware_revision`, `calibration_revision`, and `correlation_id`. Actuation validity also uses local monotonic deadlines and a fresh controller session; wall-clock timestamps alone cannot establish freshness across two computers.

The servo supply is a separately regulated, adequately rated branch rather than motor power from a GPIO pin. Confirm signal-level compatibility, grounding, protection, wire ratings, connector polarity and worst-case current of the actual units before drawing the final wiring diagram. The Pi keeps its appropriate supply. TowerPro lists MG996R operating limits, but model names and lookalike hardware do not verify a particular installed servo. [Raspberry Pi hardware guidance](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html), [MG996R manufacturer specifications](https://towerpro.com.tw/product/mg996R/)

## Performance and verification gates

These are proposed acceptance targets to measure on the assembled system, not observed performance or guarantees:

| Measurement | Initial target and method |
| --- | --- |
| Live preview | At least 15 delivered frames/s with 95th-percentile capture-to-display age below 250 ms at the initial resolution; measure with a visible time/flash test plus logs. |
| Overlay responsiveness | Local selection-to-highlight below 100 ms at the 95th percentile, excluding camera capture age. No model call needed. |
| Stream overload | Bounded memory and newest-frame behavior during a 30-minute run; no increasing latency queue. |
| Meter candidate | Stable readable display to proposed value within 1 second at the 95th percentile; reject ambiguity rather than invent a reading. |
| Pointing precision | Measured repeated error remains within the safe matte target's usable radius, with a documented margin; otherwise refuse that target. No assumed hole-level guarantee. |
| Fail-off | Verified electrical cutoff on kill, expired pulse and service/connection failure; target no more than 100 ms for the independent timeout, subject to the actual reviewed circuit. This number is not a claim that a beam exposure is safe. |

Verification proceeds in distinct layers:

1. **Synthetic tests:** transforms, unit conversion, stale revisions, malformed messages, replay, queue backpressure, rejected target geometry and state-machine transitions. No hardware success claims.
2. **Recorded replay:** labelled board/meter clips, blur, glare, occlusion, blank/overload display, negative signs, changing units, moving board and wrong camera orientation. Record false-accepts separately from correct rejections.
3. **Live cameras, laser disconnected:** Pi and phone feeds simultaneously, cable removal, cold start, overnight/long-run reconnect behavior, focus/mode changes and marker reacquisition. Measure stream latency and thermal behavior.
4. **Motor-only bench:** slow safe-range movement after mechanical fit checks; validate wiring, current demand, stability, ribbon clearance, backlash and loss-of-command behavior. Do not force geared servos by hand or against end stops.
5. **Reviewed fail-off circuit:** test with a safe non-laser indicator/load first; inject stuck-high enable, killed processes, severed Ethernet and restart. Document independently observed cutoff.
6. **Supervised physical indication:** only after every previous gate and the laser setup review pass. Record target-plane accuracy and safe operating bounds. If any gate fails, ship visual guidance with physical emission disabled until corrected.

Open items for the hardware build session are the exact phone/cable, present power supplies and servo controller, actual mounted pitch servo, laser specifications/driver, physical kill/timeout parts, current print/assembly status and available rigid camera/board mounting. These block final wiring or safe emission, not development of the simulator, video UI, voice interaction or diagnostic harness.
