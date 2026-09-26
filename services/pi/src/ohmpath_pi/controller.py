from __future__ import annotations

import math
from typing import Any

from .models import (
    AimObservation,
    AxisPair,
    ControlPhase,
    ControllerConfig,
    ControllerResult,
    HardwareSafetyState,
    LocalCalibration,
    RevisionSnapshot,
)


def _condition_number_2x2(matrix: tuple[tuple[float, float], tuple[float, float]]) -> float:
    a, b = matrix[0]
    c, d = matrix[1]
    p = a * a + c * c
    q = a * b + c * d
    r = b * b + d * d
    discriminant = math.sqrt(max(0.0, (p - r) ** 2 + 4 * q * q))
    largest = (p + r + discriminant) / 2
    smallest = (p + r - discriminant) / 2
    if smallest <= 1e-16:
        return math.inf
    return math.sqrt(largest / smallest)


def invert_jacobian(
    calibration: LocalCalibration,
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return inverse image Jacobian or fail closed if calibration is unusable."""
    if not calibration.valid:
        raise ValueError("calibration_invalid")
    if calibration.residual_px > 5.0:
        raise ValueError("calibration_residual_too_large")
    if _condition_number_2x2(calibration.jacobian_px_per_degree) > calibration.max_condition_number:
        raise ValueError("calibration_singular_or_ill_conditioned")
    a, b = calibration.jacobian_px_per_degree[0]
    c, d = calibration.jacobian_px_per_degree[1]
    determinant = a * d - b * c
    if abs(determinant) < 1e-12:
        raise ValueError("calibration_singular_or_ill_conditioned")
    inverse = ((d / determinant, -b / determinant), (-c / determinant, a / determinant))
    if any(not math.isfinite(item) for row in inverse for item in row):
        raise ValueError("calibration_singular_or_ill_conditioned")
    return inverse


class CrosshairController:
    """Two-axis deterministic control. Produces mockable bounded setpoints only."""

    def __init__(self, config: ControllerConfig | None = None) -> None:
        self.config = config or ControllerConfig()
        self._position: AxisPair = (0.0, 0.0)
        self._iteration = 0
        self._run_started: float | None = None
        self._last_move_time: float | None = None
        self._last_frame_id: str | None = None
        self._last_frame_time: float | None = None
        self._stable_count = 0
        self._last_stable_frame_time: float | None = None
        self._previous_error_sign: list[int] = [0, 0]
        self._sign_flips: list[int] = [0, 0]
        self._fault: str | None = None
        self._target_id: str | None = None
        self._last_crosshair_before_move: tuple[float, float] | None = None
        self._last_requested_delta: AxisPair | None = None

    @property
    def position_deg(self) -> AxisPair:
        return self._position

    @property
    def iteration(self) -> int:
        return self._iteration

    def reset(self, *, yaw_deg: float = 0.0, pitch_deg: float = 0.0) -> None:
        if not (self.config.min_yaw_deg <= yaw_deg <= self.config.max_yaw_deg):
            raise ValueError("initial yaw is outside configured travel")
        if not (self.config.min_pitch_deg <= pitch_deg <= self.config.max_pitch_deg):
            raise ValueError("initial pitch is outside configured travel")
        self._position = (yaw_deg, pitch_deg)
        self._iteration = 0
        self._run_started = None
        self._last_move_time = None
        self._last_frame_id = None
        self._last_frame_time = None
        self._stable_count = 0
        self._last_stable_frame_time = None
        self._previous_error_sign = [0, 0]
        self._sign_flips = [0, 0]
        self._fault = None
        self._target_id = None
        self._last_crosshair_before_move = None
        self._last_requested_delta = None

    def stop(self, reason: str = "stopped") -> None:
        self._fault = reason

    def _result(
        self,
        observation: AimObservation | None,
        phase: ControlPhase,
        safety: HardwareSafetyState,
        delta: AxisPair = (0.0, 0.0),
        error: AxisPair | None = None,
        fault: str | None = None,
    ) -> ControllerResult:
        return ControllerResult(
            target_id=observation.target_id if observation else self._target_id or "unknown",
            frame_id=observation.frame_id if observation else "unknown",
            phase=phase,
            safety_state=safety,
            target_px=observation.target_px if observation else None,
            predicted_crosshair_px=observation.predicted_crosshair_px if observation else None,
            observed_spot_px=observation.observed_spot_px if observation else None,
            error_px=error,
            yaw_pitch_deg=self._position,
            requested_delta_deg=delta,
            iteration=self._iteration,
            emission_enabled=False,
            fault=fault,
        )

    def _fail(self, observation: AimObservation | None, reason: str) -> ControllerResult:
        self._fault = reason
        return self._result(observation, ControlPhase.FAULT, HardwareSafetyState.FAULT, fault=reason)

    def update(
        self,
        observation: AimObservation,
        calibration: LocalCalibration,
        expected_revisions: RevisionSnapshot,
        *,
        now_monotonic_s: float,
    ) -> ControllerResult:
        """Process one fresh frame and return a bounded mock-driver delta."""
        if self._fault:
            return self._result(observation, ControlPhase.FAULT, HardwareSafetyState.FAULT, fault=self._fault)
        if not math.isfinite(now_monotonic_s) or now_monotonic_s < 0:
            return self._fail(observation, "invalid_monotonic_time")
        if observation.calibration_revision != calibration.calibration_revision:
            return self._fail(observation, "calibration_revision_mismatch")
        if observation.circuit_revision != expected_revisions.circuit_revision or \
                observation.firmware_revision != expected_revisions.firmware_revision or \
                observation.calibration_revision != expected_revisions.calibration_revision:
            return self._fail(observation, "stale_revisions")
        if not observation.pose_valid or observation.pose_age_s > self.config.max_pose_age_s:
            return self._fail(observation, "pose_stale_or_invalid")
        if not observation.target_visible:
            return self._fail(observation, "target_lost")
        if now_monotonic_s - observation.frame_monotonic_s > self.config.max_frame_age_s or \
                observation.frame_monotonic_s > now_monotonic_s or \
                observation.received_monotonic_s > now_monotonic_s:
            return self._fail(observation, "frame_stale_or_from_future")
        if abs(observation.target_depth_mm - observation.calibrated_depth_mm) > self.config.max_depth_mismatch_mm:
            return self._fail(observation, "target_depth_mismatch")
        if self._last_frame_id == observation.frame_id or (
            self._last_frame_time is not None and observation.frame_monotonic_s <= self._last_frame_time
        ):
            return self._fail(observation, "frame_replayed_or_out_of_order")
        if self._target_id is not None and self._target_id != observation.target_id:
            return self._fail(observation, "target_changed_during_control")

        try:
            inverse = invert_jacobian(calibration)
        except ValueError as exc:
            return self._fail(observation, str(exc))

        if self._run_started is None:
            self._run_started = now_monotonic_s
            self._target_id = observation.target_id
        if now_monotonic_s - self._run_started > self.config.max_run_time_s:
            return self._fail(observation, "controller_timeout")

        self._last_frame_id = observation.frame_id
        self._last_frame_time = observation.frame_monotonic_s
        error_u = observation.target_px[0] - observation.predicted_crosshair_px[0]
        error_v = observation.target_px[1] - observation.predicted_crosshair_px[1]
        error: AxisPair = (error_u, error_v)
        magnitude = math.hypot(error_u, error_v)

        if self._last_move_time is not None and observation.frame_monotonic_s < self._last_move_time + self.config.settle_time_s:
            return self._result(observation, ControlPhase.SETTLING, HardwareSafetyState.SETTLING, error=error)

        if self._last_crosshair_before_move is not None and self._last_requested_delta is not None:
            a, b = calibration.jacobian_px_per_degree[0]
            c, d = calibration.jacobian_px_per_degree[1]
            expected_u = self._last_crosshair_before_move[0] + a * self._last_requested_delta[0] + b * self._last_requested_delta[1]
            expected_v = self._last_crosshair_before_move[1] + c * self._last_requested_delta[0] + d * self._last_requested_delta[1]
            response_error = math.hypot(expected_u - observation.predicted_crosshair_px[0],
                                         expected_v - observation.predicted_crosshair_px[1])
            if response_error > self.config.max_response_error_px:
                return self._fail(observation, "actuator_response_mismatch")
            self._last_crosshair_before_move = None
            self._last_requested_delta = None

        if magnitude <= self.config.deadband_px:
            if self._last_stable_frame_time is None:
                self._stable_count = 1
                self._last_stable_frame_time = observation.frame_monotonic_s
            elif observation.frame_monotonic_s - self._last_stable_frame_time >= self.config.settle_time_s:
                self._stable_count += 1
                self._last_stable_frame_time = observation.frame_monotonic_s
            if self._stable_count >= self.config.stable_observations:
                return self._result(observation, ControlPhase.ALIGNED, HardwareSafetyState.DISARMED, error=error)
            return self._result(observation, ControlPhase.SETTLING, HardwareSafetyState.SETTLING, error=error)
        self._stable_count = 0
        self._last_stable_frame_time = None

        for axis, component in enumerate(error):
            sign = 1 if component > self.config.deadband_px else -1 if component < -self.config.deadband_px else 0
            if sign and self._previous_error_sign[axis] and sign != self._previous_error_sign[axis]:
                self._sign_flips[axis] += 1
            if sign:
                self._previous_error_sign[axis] = sign
        if max(self._sign_flips) >= self.config.oscillation_limit:
            return self._fail(observation, "oscillation_detected")
        if self._iteration >= self.config.max_iterations:
            return self._fail(observation, "iteration_limit")

        requested_yaw = inverse[0][0] * error_u + inverse[0][1] * error_v
        requested_pitch = inverse[1][0] * error_u + inverse[1][1] * error_v
        dt = max(0.0, observation.frame_monotonic_s - self._last_move_time) if self._last_move_time is not None else 0.0
        speed_limit = self.config.max_speed_deg_s * (dt if self._last_move_time is not None
                                                     else self.config.settle_time_s)
        axis_limit = min(self.config.max_step_deg, speed_limit)
        dyaw = max(-axis_limit, min(axis_limit, requested_yaw))
        dpitch = max(-axis_limit, min(axis_limit, requested_pitch))

        desired_yaw = self._position[0] + dyaw
        desired_pitch = self._position[1] + dpitch
        bounded_yaw = max(self.config.min_yaw_deg, min(self.config.max_yaw_deg, desired_yaw))
        bounded_pitch = max(self.config.min_pitch_deg, min(self.config.max_pitch_deg, desired_pitch))
        dyaw, dpitch = bounded_yaw - self._position[0], bounded_pitch - self._position[1]
        if abs(dyaw) < 1e-9 and abs(dpitch) < 1e-9:
            return self._fail(observation, "travel_limit_reached")

        self._last_crosshair_before_move = observation.predicted_crosshair_px
        self._last_requested_delta = (dyaw, dpitch)
        self._position = (bounded_yaw, bounded_pitch)
        self._iteration += 1
        self._last_move_time = now_monotonic_s
        return self._result(observation, ControlPhase.MOVING, HardwareSafetyState.MOVING,
                            delta=(dyaw, dpitch), error=error)


def run_aim_demo(
    target_x: float,
    target_y: float,
    *,
    start_crosshair_px: tuple[float, float] = (320.0, 240.0),
    target_id: str = "demo-target",
    max_frames: int = 64,
) -> dict[str, Any]:
    """Run a deterministic simulated plant and return a UI-ready frame sequence.

    Pixels and actuator angles in this result are synthetic. This function never
    creates a Pi service, opens a camera, touches GPIO, or enables laser emission.
    """
    values = (target_x, target_y, *start_crosshair_px)
    if len(start_crosshair_px) != 2 or any(not math.isfinite(value) or abs(value) > 100_000 for value in values):
        raise ValueError("demo target and crosshair coordinates must be finite and bounded")
    if not target_id or len(target_id) > 128:
        raise ValueError("demo target ID must be present and bounded")
    if not 1 <= max_frames <= 128:
        raise ValueError("max_frames must be between 1 and 128")
    jacobian = ((20.0, 6.0), (4.0, -18.0))
    calibration = LocalCalibration(
        "simulation-calibration-v1", jacobian, residual_px=0.0, valid=True,
    )
    revisions = RevisionSnapshot("simulation-circuit-v1", None, calibration.calibration_revision)
    config = ControllerConfig(max_iterations=min(12, max_frames))
    controller = CrosshairController(config)
    crosshair = (float(start_crosshair_px[0]), float(start_crosshair_px[1]))
    target = (float(target_x), float(target_y))
    frames: list[dict[str, Any]] = []
    result: ControllerResult | None = None
    timestamp = 100.0

    for index in range(max_frames):
        observation = AimObservation(
            target_id=target_id, frame_id=f"sim-{index + 1}", target_px=target,
            predicted_crosshair_px=crosshair, frame_monotonic_s=timestamp,
            received_monotonic_s=timestamp, circuit_revision=revisions.circuit_revision,
            firmware_revision=revisions.firmware_revision,
            calibration_revision=revisions.calibration_revision, pose_valid=True,
            pose_age_s=0.0, plane_id="simulation-plane", target_depth_mm=100.0,
            calibrated_depth_mm=100.0,
        )
        result = controller.update(observation, calibration, revisions, now_monotonic_s=timestamp)
        if result.phase == ControlPhase.MOVING:
            yaw_delta, pitch_delta = result.requested_delta_deg
            crosshair = (
                crosshair[0] + jacobian[0][0] * yaw_delta + jacobian[0][1] * pitch_delta,
                crosshair[1] + jacobian[1][0] * yaw_delta + jacobian[1][1] * pitch_delta,
            )
        frames.append({
            "frame_id": observation.frame_id,
            "target_pixel": [target[0], target[1]],
            "crosshair_pixel": [crosshair[0], crosshair[1]],
            "yaw_degrees": result.yaw_pitch_deg[0],
            "pitch_degrees": result.yaw_pitch_deg[1],
            "phase": result.phase.value,
            "observed_spot_pixel": None,
        })
        if result.phase in {ControlPhase.ALIGNED, ControlPhase.FAULT}:
            break
        timestamp += 0.2

    converged = result is not None and result.phase == ControlPhase.ALIGNED
    fault = result.fault if result is not None else "no_frames_processed"
    if not converged and fault is None:
        fault = "demo_frame_limit"
    return {
        "frames": frames,
        "converged": converged,
        "fault": fault,
        "mode": "simulation",
        "laser_enabled": False,
    }
