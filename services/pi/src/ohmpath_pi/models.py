from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import math
from typing import TypeAlias

Pixel: TypeAlias = tuple[float, float]
AxisPair: TypeAlias = tuple[float, float]
RevisionTuple: TypeAlias = tuple[str, str | None, str]


def _finite_pair(value: tuple[float, float], label: str) -> None:
    if len(value) != 2 or any(not math.isfinite(v) for v in value):
        raise ValueError(f"{label} must contain two finite numbers")


@dataclass(frozen=True, slots=True)
class LocalCalibration:
    """Measured local image Jacobian in pixels per degree: ((du/dyaw,du/dpitch),(dv/dyaw,dv/dpitch))."""

    calibration_revision: str
    jacobian_px_per_degree: tuple[tuple[float, float], tuple[float, float]]
    max_condition_number: float = 20.0
    residual_px: float = 1.0
    valid: bool = True

    def __post_init__(self) -> None:
        if not self.calibration_revision:
            raise ValueError("calibration revision is required")
        if len(self.jacobian_px_per_degree) != 2 or any(len(row) != 2 for row in self.jacobian_px_per_degree):
            raise ValueError("Jacobian must be a 2 by 2 matrix")
        if any(not math.isfinite(v) for row in self.jacobian_px_per_degree for v in row):
            raise ValueError("Jacobian values must be finite")
        if not math.isfinite(self.max_condition_number) or self.max_condition_number <= 1:
            raise ValueError("maximum condition number must be finite and greater than one")
        if not math.isfinite(self.residual_px) or self.residual_px < 0:
            raise ValueError("calibration residual must be finite and non-negative")


@dataclass(frozen=True, slots=True)
class AimObservation:
    target_id: str
    frame_id: str
    target_px: Pixel
    predicted_crosshair_px: Pixel
    frame_monotonic_s: float
    received_monotonic_s: float
    circuit_revision: str | None
    firmware_revision: str | None
    calibration_revision: str
    pose_valid: bool
    pose_age_s: float
    plane_id: str
    target_depth_mm: float
    calibrated_depth_mm: float
    observed_spot_px: Pixel | None = None
    target_visible: bool = True

    def __post_init__(self) -> None:
        if not self.target_id or not self.frame_id or not self.plane_id:
            raise ValueError("target, frame, and plane identifiers are required")
        _finite_pair(self.target_px, "target pixel")
        _finite_pair(self.predicted_crosshair_px, "predicted crosshair pixel")
        if self.observed_spot_px is not None:
            _finite_pair(self.observed_spot_px, "observed spot pixel")
        values = (self.frame_monotonic_s, self.received_monotonic_s, self.pose_age_s,
                  self.target_depth_mm, self.calibrated_depth_mm)
        if any(not math.isfinite(value) for value in values):
            raise ValueError("observation timing and depth values must be finite")
        if min(self.frame_monotonic_s, self.received_monotonic_s, self.pose_age_s) < 0:
            raise ValueError("observation timing values must be non-negative")


@dataclass(frozen=True, slots=True)
class ControllerConfig:
    deadband_px: float = 3.0
    max_frame_age_s: float = 0.25
    max_pose_age_s: float = 0.25
    max_depth_mismatch_mm: float = 2.0
    max_step_deg: float = 2.0
    max_speed_deg_s: float = 8.0
    min_yaw_deg: float = -80.0
    max_yaw_deg: float = 80.0
    min_pitch_deg: float = -30.0
    max_pitch_deg: float = 30.0
    settle_time_s: float = 0.15
    stable_observations: int = 2
    max_response_error_px: float = 4.0
    max_iterations: int = 12
    max_run_time_s: float = 10.0
    oscillation_limit: int = 3

    def __post_init__(self) -> None:
        positive = (self.deadband_px, self.max_frame_age_s, self.max_pose_age_s,
                    self.max_depth_mismatch_mm, self.max_step_deg, self.max_speed_deg_s,
                    self.settle_time_s, self.max_run_time_s, self.max_response_error_px)
        if any(not math.isfinite(value) or value <= 0 for value in positive):
            raise ValueError("controller bounds must be finite and positive")
        if self.min_yaw_deg >= self.max_yaw_deg or self.min_pitch_deg >= self.max_pitch_deg:
            raise ValueError("travel minimum must be less than maximum")
        if any(not math.isfinite(value) for value in (self.min_yaw_deg, self.max_yaw_deg, self.min_pitch_deg, self.max_pitch_deg)):
            raise ValueError("travel bounds must be finite")
        if self.stable_observations < 1 or self.max_iterations < 1 or self.oscillation_limit < 1:
            raise ValueError("iteration and stability counts must be positive")


class ControlPhase(StrEnum):
    IDLE = "idle"
    ACQUIRING = "acquiring"
    MOVING = "moving"
    SETTLING = "settling"
    ALIGNED = "aligned"
    FAULT = "fault"


class HardwareSafetyState(StrEnum):
    DISARMED = "disarmed"
    READY = "ready"
    MOVING = "moving"
    SETTLING = "settling"
    INDICATING = "indicating"
    FAULT = "fault"


@dataclass(frozen=True, slots=True)
class ControllerResult:
    target_id: str
    frame_id: str
    phase: ControlPhase
    safety_state: HardwareSafetyState
    target_px: Pixel | None
    predicted_crosshair_px: Pixel | None
    observed_spot_px: Pixel | None
    error_px: Pixel | None
    yaw_pitch_deg: AxisPair
    requested_delta_deg: AxisPair
    iteration: int
    emission_enabled: bool
    fault: str | None = None

    def __post_init__(self) -> None:
        _finite_pair(self.yaw_pitch_deg, "yaw/pitch position")
        _finite_pair(self.requested_delta_deg, "yaw/pitch request")
        if self.error_px is not None:
            _finite_pair(self.error_px, "pixel error")
        if self.emission_enabled:
            raise ValueError("this build cannot enable laser emission")


@dataclass(frozen=True, slots=True)
class RevisionSnapshot:
    circuit_revision: str | None
    firmware_revision: str | None
    calibration_revision: str

    def __post_init__(self) -> None:
        if not self.calibration_revision:
            raise ValueError("calibration revision is required")
        if self.circuit_revision is not None and not isinstance(self.circuit_revision, str):
            raise ValueError("circuit revision must be text or unknown")
        if self.firmware_revision is not None and not isinstance(self.firmware_revision, str):
            raise ValueError("firmware revision must be text or unknown")

    def tuple(self) -> RevisionTuple:
        return (self.calibration_revision, self.circuit_revision, self.firmware_revision)
