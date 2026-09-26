# Pi controller handoff

Status: **dry-run implementation only**. The controller, Pi command receiver, camera wrapper, and SSH configuration helper are ready for coordinator integration. No hardware or SSH connection was opened, and no physical test was performed.

## Public APIs

- `CrosshairController(config: ControllerConfig | None = None)`. Call `update(observation: AimObservation, calibration: LocalCalibration, expected_revisions: RevisionSnapshot, *, now_monotonic_s: float) -> ControllerResult` once per new camera frame. It returns bounded yaw/pitch setpoints and progress/safety metadata. `reset(yaw_deg=0.0, pitch_deg=0.0)` starts a new control attempt; `stop(reason="stopped")` latches a fault.
- `invert_jacobian(calibration: LocalCalibration) -> ((float, float), (float, float))` solves the measured local pixel-per-degree map. It rejects invalid, high-residual, singular, or ill-conditioned calibration.
- `run_aim_demo(target_x: float, target_y: float, *, start_crosshair_px=(320.0, 240.0), target_id="demo-target", max_frames=64) -> dict` is the UI simulation entry point. It returns `{frames, converged, fault, mode: "simulation", laser_enabled: false}`. Every frame contains `target_pixel`, `crosshair_pixel`, `yaw_degrees`, `pitch_degrees`, `phase`, and `observed_spot_pixel: null`. Its pixels, calibration, simulated plant, and angles are synthetic.
- `PiControlService(..., initial_revisions: RevisionSnapshot | None, allowed_targets: frozenset[str], ...)` is the idempotent command receiver. Call `link_state(...)` only from a separately verified transport supervisor, send strictly increasing local monotonic `heartbeat(...)` updates, call `watchdog_tick(...)` periodically, and submit `MotionCommand` through `submit(command, *, now_monotonic_s=None) -> CommandAck`. Each process starts with fresh random connection and arming epochs. The service accepts only the included mock motor driver.
- `PiCameraCapture(enabled=False, calibration_revision="unknown", source_factory=None)` is inert on import/construction. `start()` or `start_stream(max_fps=15.0)` opens Picamera2 only after `enabled=True`; `capture_latest(...)` returns a JPEG; `take_latest_frame(...)` reads a single replace-old slot; `stop()` closes the stream. `LatestFrameBuffer` is available for local streaming integrations.
- `create_loopback_server(service, *, bearer_token, port=8765)` constructs a service bound only to `127.0.0.1`. It exposes authenticated health and a bounded mock motion endpoint. The caller must explicitly invoke `serve_forever()` to start it.
- `python -m ohmpath_pi --demo X Y` prints the deterministic synthetic controller run as JSON and exits. `python -m ohmpath_pi --port 8765` starts the mock-only loopback HTTP service; it requires a per-launch `OHMPATH_PI_TOKEN` with at least 32 characters. Optional `--target ID` entries define the accepted semantic-target allowlist and require `--circuit-revision REV --calibration-revision REV` (with optional `--firmware-revision REV`). The server has no camera or physical-driver startup path.
- `PiTunnelConfig(...).ssh_args("control" | "video") -> list[str]` checks a literal pinned host-key fingerprint and returns a fixed SSH argument list. The caller must start two separate SSH processes. No SSH process is started here.

`ControllerResult` keeps `target_px`, `predicted_crosshair_px`, and `observed_spot_px` separate. Commands never create an observed spot. The controller checks frame/pose age, circuit/firmware/calibration revisions, target visibility, target depth, target identity, measured actuator response, settling, both-axis travel/speed, iteration/time bounds, and oscillation. It always returns `emission_enabled=False`; `PiControlService` also has no laser-enable request or API. `ALIGNED` maps to a disarmed safety state.

The receiver requires a current revision snapshot and explicit target allowlist. It checks bounded per-axis steps and position limits, local monotonic TTL, speed, connection/arming epochs, unique command IDs, and payload hashes. Replaying the same ID returns its prior acknowledgement without repeating a move; a changed payload is rejected. Unknown outcomes immediately invalidate both epochs and disconnect the receiver. Reconciliation is allowed while disarmed and never repeats the command. A full bounded command ledger disconnects rather than evicting replay history.

## Verification

Command: `.venv/Scripts/python.exe -m pytest services/bench/tests/test_pi_link.py -q`

Result: **27 passed in 0.08s**. The suite uses deterministic simulated plants and local mocks. It covers four coupled-axis target directions, convergence/deadband, settle/reobserve, speed/travel/iteration/time bounds, stale and replayed frames, revision/depth/target failures, singular calibration, simulated stuck axis, oscillation, UI demo output at three points and the standalone CLI demo, idempotency and changed-payload rejection, TTLs, stale epochs, watchdog disarm, unknown command reconciliation, bounded command history, target allowlist, camera opt-in/newest-frame behavior, and SSH host-key rotation rejection. The CLI demo was also run directly with `--demo 380 210`; it converged in four simulated frames and reported `mode="simulation"` and `laser_enabled=false`.

This is synthetic controller and mock-service evidence. It does not verify servo fit, travel, speed, backlash, ribbon clearance, camera pose, network latency, watchdog wiring, physical cutoff, or laser behavior. No Raspberry Pi, GPIO, PWM, motor, laser, SSH, or remote camera was accessed.

## Raspberry Pi setup notes

The controller and command service use only the Python standard library. On Raspberry Pi OS 64-bit, use a supported system Python and transfer the reviewed project source to the Pi over the approved private-link setup. The core dry-run test command from the repository is:

```sh
PYTHONPATH=services/pi/src:services/bench/src python3 -m pytest services/bench/tests/test_pi_link.py -q
```

To run a local mock service, set a fresh random token for that process and launch `PYTHONPATH=services/pi/src python3 -m ohmpath_pi --port 8765`. The CLI binds only `127.0.0.1`; use the token as an HTTP bearer credential. For a synthetic aiming result, run `PYTHONPATH=services/pi/src python3 -m ohmpath_pi --demo 380 210`. Neither command opens a camera, starts SSH, or controls hardware.

Picamera2 is optional. If camera use is later authorized, install the Raspberry Pi OS package with `sudo apt install python3-picamera2`; for a virtual environment, expose the OS package with `python3 -m venv --system-site-packages <venv>`. No `pip` dependency or paid service is needed by this dry-run slice. Importing the package does not import Picamera2 or open a camera; `PiCameraCapture(enabled=True).start()` is the explicit opt-in boundary.

The loopback server is a local prototype. A desktop SSH supervisor must pair and review the Pi host key out of band, validate the pinned fingerprint, and launch independent control and video tunnels with the returned argument lists. Keep both listeners on loopback. A reviewed supervisor must call the link and heartbeat methods; without it, the receiver remains disconnected and rejects commands. The current build cannot attach a physical actuator driver.

Required future physical gates remain: motor supply and wiring review; laser physically disconnected; slow movement within a measured safe range; camera/beam-plane and held-out target calibration; travel, speed, settling and backlash measurements; cable sweep; independent cutoff verification with a safe dummy load; and supervised target validation. Emission stays disabled until the separate safety design and acceptance gates pass.

## Changed paths

- `services/pi/src/ohmpath_pi/__init__.py`
- `services/pi/src/ohmpath_pi/models.py`
- `services/pi/src/ohmpath_pi/controller.py`
- `services/pi/src/ohmpath_pi/service.py`
- `services/pi/src/ohmpath_pi/camera.py`
- `services/pi/src/ohmpath_pi/loopback.py`
- `services/pi/src/ohmpath_pi/__main__.py`
- `services/bench/src/ohmpath/devices/pi_link.py`
- `services/bench/tests/test_pi_link.py`
- `docs/development/pi-controller-handoff.md`

No shared schema, lockfile, or dependency file was changed. Proposed commit title: **Add dry-run Pi aiming and control service**
