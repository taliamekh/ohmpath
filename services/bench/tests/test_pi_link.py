from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
from pathlib import Path

import pytest

from ohmpath_pi.camera import CameraFrame, LatestFrameBuffer, PiCameraCapture
from ohmpath_pi.controller import CrosshairController, run_aim_demo
from ohmpath_pi.loopback import create_loopback_server
from ohmpath_pi.__main__ import main as pi_main
from ohmpath_pi.models import (
    AimObservation,
    ControlPhase,
    ControllerConfig,
    HardwareSafetyState,
    LocalCalibration,
    RevisionSnapshot,
)
from ohmpath_pi.service import AckState, MockMotorDriver, MotionCommand, PiControlService
from ohmpath.devices.pi_link import PiTunnelConfig, fingerprint_known_host


REVISIONS = RevisionSnapshot("circuit-r2", None, "cal-r1")
JACOBIAN = ((8.0, 3.0), (2.0, -7.0))
CALIBRATION = LocalCalibration("cal-r1", JACOBIAN, residual_px=0.5)


def test_nonfinite_travel_configuration_is_rejected():
    with pytest.raises(ValueError):
        ControllerConfig(min_yaw_deg=float("nan"))


def test_command_receiver_checks_heartbeat_without_external_watchdog_tick():
    service = PiControlService(initial_revisions=REVISIONS, allowed_targets=frozenset({"pad-A"}))
    service.link_state(True, now_monotonic_s=10)
    command = MotionCommand("late-1", .1, .1, "pad-A", 12.5, service.connection_epoch, service.arming_epoch, REVISIONS)
    result = service.submit(command, now_monotonic_s=12)
    assert result.reason == "heartbeat_stale_disarmed"
    assert not service.connected
    assert not service.driver.steps


def observation(
    *, frame_id: str = "frame-1", t: float = 10.0,
    crosshair: tuple[float, float] = (200.0, 200.0),
    target: tuple[float, float] = (280.0, 140.0), **overrides: object,
) -> AimObservation:
    fields: dict[str, object] = {
        "target_id": "pad-A", "frame_id": frame_id, "target_px": target,
        "predicted_crosshair_px": crosshair, "frame_monotonic_s": t,
        "received_monotonic_s": t, "circuit_revision": "circuit-r2",
        "firmware_revision": None, "calibration_revision": "cal-r1",
        "pose_valid": True, "pose_age_s": 0.01, "plane_id": "board-plane",
        "target_depth_mm": 100.0, "calibrated_depth_mm": 100.0,
    }
    fields.update(overrides)
    return AimObservation(**fields)  # type: ignore[arg-type]


def run_plant(initial_error: tuple[float, float]) -> tuple[CrosshairController, list[tuple[float, float]]]:
    controller = CrosshairController()
    target = (250.0 + initial_error[0], 250.0 + initial_error[1])
    crosshair = (250.0, 250.0)
    time_s = 10.0
    deltas: list[tuple[float, float]] = []
    for index in range(50):
        result = controller.update(
            observation(frame_id=f"f-{index}", t=time_s, crosshair=crosshair, target=target),
            CALIBRATION, REVISIONS, now_monotonic_s=time_s,
        )
        if result.phase == ControlPhase.ALIGNED:
            return controller, deltas
        assert result.phase != ControlPhase.FAULT, result.fault
        if result.phase == ControlPhase.MOVING:
            dyaw, dpitch = result.requested_delta_deg
            deltas.append((dyaw, dpitch))
            crosshair = (
                crosshair[0] + JACOBIAN[0][0] * dyaw + JACOBIAN[0][1] * dpitch,
                crosshair[1] + JACOBIAN[1][0] * dyaw + JACOBIAN[1][1] * dpitch,
            )
        time_s += 0.2
    raise AssertionError("closed-loop simulated plant failed to converge")


@pytest.mark.parametrize("error", [(80.0, -60.0), (-80.0, 60.0), (70.0, 50.0), (-70.0, -50.0)])
def test_simulated_coupled_plant_converges_in_both_directions(error: tuple[float, float]) -> None:
    controller, deltas = run_plant(error)
    assert deltas
    assert controller.iteration <= 12
    assert all(abs(yaw) <= 2.0 and abs(pitch) <= 2.0 for yaw, pitch in deltas)


def test_result_separates_predicted_crosshair_and_observed_spot() -> None:
    controller = CrosshairController()
    result = controller.update(observation(), CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    assert result.phase == ControlPhase.MOVING
    assert result.predicted_crosshair_px == (200.0, 200.0)
    assert result.observed_spot_px is None
    assert result.emission_enabled is False
    assert result.safety_state != HardwareSafetyState.INDICATING


@pytest.mark.parametrize("target", [(100.0, 80.0), (0.0, 0.0), (640.0, 480.0)])
def test_ui_aim_demo_returns_converged_simulation_frames(target: tuple[float, float]) -> None:
    result = run_aim_demo(*target)
    assert result["mode"] == "simulation"
    assert result["converged"] is True, result["fault"]
    assert result["laser_enabled"] is False
    assert result["frames"][-1]["phase"] == ControlPhase.ALIGNED.value
    assert result["frames"][-1]["target_pixel"] == list(target)
    assert result["frames"][-1]["observed_spot_pixel"] is None
    assert len(result["frames"]) <= 64


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"target_visible": False}, "target_lost"),
        ({"pose_valid": False}, "pose_stale_or_invalid"),
        ({"calibration_revision": "cal-old"}, "calibration_revision_mismatch"),
        ({"circuit_revision": "circuit-old"}, "stale_revisions"),
        ({"target_depth_mm": 110.0}, "target_depth_mismatch"),
    ],
)
def test_lost_or_stale_geometry_stops_immediately(changes: dict[str, object], reason: str) -> None:
    result = CrosshairController().update(
        observation(**changes), CALIBRATION, REVISIONS, now_monotonic_s=10.0,
    )
    assert result.phase == ControlPhase.FAULT
    assert result.fault == reason
    assert result.requested_delta_deg == (0.0, 0.0)
    assert result.emission_enabled is False


def test_old_frame_and_pose_timeout_stop() -> None:
    stale_frame = observation(t=9.0)
    result = CrosshairController().update(stale_frame, CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    assert result.fault == "frame_stale_or_from_future"
    stale_pose = observation(pose_age_s=0.5)
    result = CrosshairController().update(stale_pose, CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    assert result.fault == "pose_stale_or_invalid"

    controller = CrosshairController()
    first = controller.update(observation(), CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    assert first.phase == ControlPhase.MOVING
    replay = controller.update(observation(frame_id="frame-1", t=10.2), CALIBRATION,
                               REVISIONS, now_monotonic_s=10.2)
    assert replay.fault == "frame_replayed_or_out_of_order"


def test_singular_calibration_fails_closed() -> None:
    bad = LocalCalibration("cal-r1", ((1.0, 2.0), (2.0, 4.0)))
    result = CrosshairController().update(observation(), bad, REVISIONS, now_monotonic_s=10.0)
    assert result.phase == ControlPhase.FAULT
    assert result.fault == "calibration_singular_or_ill_conditioned"


def test_speed_travel_iteration_timeout_and_settling_limits() -> None:
    slow = ControllerConfig(max_speed_deg_s=1.0)
    controller = CrosshairController(slow)
    result = controller.update(observation(), CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    assert result.phase == ControlPhase.MOVING
    assert max(map(abs, result.requested_delta_deg)) <= 2.0
    assert max(map(abs, result.requested_delta_deg)) <= slow.max_speed_deg_s * slow.settle_time_s
    early = controller.update(observation(frame_id="early", t=10.05), CALIBRATION, REVISIONS,
                              now_monotonic_s=10.05)
    assert early.phase == ControlPhase.SETTLING
    assert early.requested_delta_deg == (0.0, 0.0)

    edge = CrosshairController()
    edge.reset(yaw_deg=80.0, pitch_deg=-30.0)
    identity = LocalCalibration("cal-r1", ((1.0, 0.0), (0.0, 1.0)))
    at_limit = edge.update(observation(), identity, REVISIONS, now_monotonic_s=10.0)
    assert at_limit.phase == ControlPhase.FAULT
    assert at_limit.fault == "travel_limit_reached"

    timed = CrosshairController(ControllerConfig(max_run_time_s=0.5))
    timed.update(observation(), CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    expired = timed.update(observation(frame_id="late", t=10.6), CALIBRATION, REVISIONS,
                           now_monotonic_s=10.6)
    assert expired.fault == "controller_timeout"


def test_stuck_axis_is_detected_from_missing_calibrated_response() -> None:
    controller = CrosshairController()
    first = observation()
    result = controller.update(first, CALIBRATION, REVISIONS, now_monotonic_s=10.0)
    dyaw, _dpitch = result.requested_delta_deg
    # Simulate yaw responding while pitch remains stuck despite a nonzero request.
    crosshair = (first.predicted_crosshair_px[0] + JACOBIAN[0][0] * dyaw,
                 first.predicted_crosshair_px[1] + JACOBIAN[1][0] * dyaw)
    next_obs = observation(frame_id="f2", t=10.2, crosshair=crosshair)
    stopped = controller.update(next_obs, CALIBRATION, REVISIONS, now_monotonic_s=10.2)
    assert stopped.phase == ControlPhase.FAULT
    assert stopped.fault == "actuator_response_mismatch"


def test_repeated_overshoot_faults_instead_of_hunting() -> None:
    config = ControllerConfig(deadband_px=1.0, max_response_error_px=100.0, oscillation_limit=2)
    controller = CrosshairController(config)
    calibration = LocalCalibration("cal-r1", ((10.0, 0.0), (0.0, 10.0)))
    crosshair = (200.0, 200.0)
    target = (210.0, 200.0)
    t = 10.0
    for index in range(5):
        result = controller.update(observation(frame_id=f"o{index}", t=t,
                                               crosshair=crosshair, target=target),
                                   calibration, REVISIONS, now_monotonic_s=t)
        if result.fault:
            break
        dyaw, dpitch = result.requested_delta_deg
        # Deliberately inject a repeatable 2x plant gain so the loop alternates.
        crosshair = (crosshair[0] + 20.0 * dyaw, crosshair[1] + 20.0 * dpitch)
        t += 0.2
    assert result.fault == "oscillation_detected"


def _command(command_id: str = "cmd-1", *, yaw: float = 0.5, deadline: float = 1.5,
             connection_epoch: int = 1, arming_epoch: int = 1) -> MotionCommand:
    return MotionCommand(command_id, yaw, -0.25, "pad-A", deadline, connection_epoch, arming_epoch, REVISIONS)


def test_command_idempotency_payload_hash_and_epoch_checks() -> None:
    driver = MockMotorDriver()
    service = PiControlService(driver=driver, initial_revisions=REVISIONS, allowed_targets=frozenset({"pad-A"}))
    service.link_state(True, now_monotonic_s=1.0)
    command = _command(connection_epoch=service.connection_epoch, arming_epoch=service.arming_epoch)
    first = service.submit(command, now_monotonic_s=1.0)
    duplicate = service.submit(command, now_monotonic_s=1.1)
    assert first.state == AckState.COMPLETED
    assert duplicate == first
    assert len(driver.steps) == 1
    changed = service.submit(_command(yaw=0.75, connection_epoch=service.connection_epoch,
                                      arming_epoch=service.arming_epoch), now_monotonic_s=1.2)
    assert changed.state == AckState.REJECTED
    assert changed.reason == "command_id_payload_conflict"
    service.disarm()
    stale = service.submit(command, now_monotonic_s=1.3)
    assert stale == first  # Idempotent replay cannot move again after disarm.
    newer_id = _command("cmd-2", connection_epoch=service.connection_epoch,
                        arming_epoch=1)
    assert service.submit(newer_id, now_monotonic_s=1.3).reason == "stale_arming_epoch"
    assert service.physical_emission_enabled is False


def test_command_target_travel_speed_and_ledger_limits() -> None:
    driver = MockMotorDriver()
    service = PiControlService(driver=driver, initial_revisions=REVISIONS,
                               allowed_targets=frozenset({"pad-A"}), max_step_deg=2.0,
                               max_speed_deg_s=8.0, max_yaw_deg=1.0, ledger_limit=3)
    service.link_state(True, now_monotonic_s=1.0)
    epochs = {"connection_epoch": service.connection_epoch, "arming_epoch": service.arming_epoch}
    wrong_target = service.submit(replace(_command("wrong-target", **epochs), target_id="other"),
                                  now_monotonic_s=1.0)
    assert wrong_target.reason == "target_not_authorized"
    out_of_travel = service.submit(_command("travel", yaw=1.5, **epochs), now_monotonic_s=1.0)
    assert out_of_travel.reason == "yaw_travel_limit"
    fast = service.submit(_command("fast", yaw=0.5, **epochs), now_monotonic_s=1.0)
    assert fast.state == AckState.COMPLETED
    full = service.submit(_command("ledger-full", deadline=2.0, **epochs), now_monotonic_s=1.01)
    assert full.state == AckState.REJECTED
    assert full.reason == "command_ledger_full_disarmed"
    assert service.connected is False
    assert len(service._commands) == 3

    rate_limited = PiControlService(initial_revisions=REVISIONS,
                                    allowed_targets=frozenset({"pad-A"}))
    rate_limited.link_state(True, now_monotonic_s=1.0)
    command = _command("first-too-fast", yaw=2.0,
                       connection_epoch=rate_limited.connection_epoch,
                       arming_epoch=rate_limited.arming_epoch)
    assert rate_limited.submit(command, now_monotonic_s=1.0).reason == "speed_limit_exceeded"


def test_expiry_ttl_watchdog_and_unknown_outcome_are_fail_closed() -> None:
    driver = MockMotorDriver()
    service = PiControlService(driver=driver, initial_revisions=REVISIONS, allowed_targets=frozenset({"pad-A"}))
    service.link_state(True, now_monotonic_s=10.0)
    expired = _command("expired", deadline=20.0, connection_epoch=service.connection_epoch,
                       arming_epoch=service.arming_epoch)
    assert service.submit(expired, now_monotonic_s=10.0).reason == "command_ttl_too_long"
    short = _command("too-late", deadline=10.1, connection_epoch=service.connection_epoch,
                     arming_epoch=service.arming_epoch)
    assert service.submit(short, now_monotonic_s=10.2).reason == "command_expired"

    driver.unknown_next = True
    unknown = _command("unknown", deadline=10.8, connection_epoch=service.connection_epoch,
                       arming_epoch=service.arming_epoch)
    first = service.submit(unknown, now_monotonic_s=10.3)
    duplicate = service.submit(unknown, now_monotonic_s=10.4)
    assert first.state == duplicate.state == AckState.UNKNOWN
    assert len(driver.steps) == 0
    assert service.connected is False
    assert service.hardware_safety_state == "disarmed"
    # Disconnected reconciliation records uncertainty without retrying the driver.
    reconciled = service.reconcile_unknown("unknown", outcome_confirmed=False)
    assert reconciled.state == AckState.FAULT
    assert len(driver.steps) == 0

    service.link_state(True, now_monotonic_s=20.0)
    assert service.watchdog_tick(now_monotonic_s=21.2) is True
    assert service.hardware_safety_state == "disarmed"
    assert service.physical_emission_enabled is False
    service.link_state(True, now_monotonic_s=22.0)
    assert service.heartbeat(now_monotonic_s=float("nan")) is False
    assert service.watchdog_tick(now_monotonic_s=float("nan")) is True


def test_camera_is_disabled_without_explicit_opt_in_and_mock_is_safe() -> None:
    calls: list[str] = []

    def factory() -> object:
        calls.append("opened")
        raise AssertionError("must not instantiate before explicit opt-in")

    camera = PiCameraCapture(source_factory=factory)  # constructing is inert
    assert calls == []
    with pytest.raises(RuntimeError, match="disabled"):
        camera.start()
    assert calls == []
    assert type(PiControlService().driver) is MockMotorDriver


def test_camera_only_opens_after_explicit_enable_and_returns_jpeg_metadata() -> None:
    class Source:
        running = False

        def start(self) -> None:
            self.running = True

        def capture_jpeg(self) -> bytes:
            assert self.running
            return b"\xff\xd8fake-jpeg"

        def stop(self) -> None:
            self.running = False

    source = Source()
    opened: list[bool] = []
    camera = PiCameraCapture(enabled=True, calibration_revision="cal-r1",
                              source_factory=lambda: (opened.append(True), source)[1])
    assert opened == []
    camera.start()
    frame = camera.capture_latest(now_monotonic_s=123.5)
    assert frame.frame_id == "pi-1"
    assert frame.calibration_revision == "cal-r1"
    assert frame.jpeg.startswith(b"\xff\xd8")
    camera.stop()


def test_camera_frame_buffer_replaces_unread_old_frames() -> None:
    buffer = LatestFrameBuffer()
    buffer.publish(CameraFrame("old", 1.0, b"\xff\xd8old", "cal-r1"))
    buffer.publish(CameraFrame("new", 2.0, b"\xff\xd8new", "cal-r1"))
    assert buffer.take_latest(timeout_s=0.01).frame_id == "new"
    buffer.close()
    assert buffer.take_latest(timeout_s=0.01) is None


def test_ssh_args_pin_host_key_and_separate_control_video(tmp_path: Path) -> None:
    key = b"test-key-material"
    key_text = base64.b64encode(key).decode("ascii")
    known_hosts = tmp_path / "known_hosts"
    known_hosts.write_text(f"pi.local ssh-ed25519 {key_text}\n", encoding="utf-8")
    expected = "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode("ascii").rstrip("=")
    identity = tmp_path / "id_ed25519"
    identity.write_text("test private-key placeholder", encoding="utf-8")
    config = PiTunnelConfig("pi.local", "ohmpath", known_hosts, identity, expected)
    control = config.ssh_args("control")
    video = config.ssh_args("video")
    assert "StrictHostKeyChecking=yes" in control
    assert "ControlMaster=no" in control and "ControlPath=none" in control
    assert "127.0.0.1:18765:127.0.0.1:8765" in control
    assert "127.0.0.1:18766:127.0.0.1:8766" in video
    assert control != video
    assert fingerprint_known_host(known_hosts, "pi.local") == expected

    known_hosts.write_text("pi.local ssh-ed25519 " + base64.b64encode(b"changed").decode() + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="changed"):
        config.ssh_args("control")


def test_loopback_server_is_constructed_only_on_explicit_call_and_requires_token() -> None:
    with pytest.raises(ValueError, match="bearer"):
        create_loopback_server(PiControlService(), bearer_token="short")


def test_module_cli_demo_prints_ui_shape_without_starting_service(capsys: pytest.CaptureFixture[str]) -> None:
    assert pi_main(["--demo", "120", "95"]) == 0
    output = __import__("json").loads(capsys.readouterr().out)
    assert output["mode"] == "simulation"
    assert output["converged"] is True
    assert output["laser_enabled"] is False
