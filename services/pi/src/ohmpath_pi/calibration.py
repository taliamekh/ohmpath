"""Offline local image-Jacobian fit from explicitly supplied calibration samples.

This module only performs arithmetic. It does not connect to a camera, controller,
motor driver, GPIO, PWM, network service, or laser.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Literal, Mapping, Sequence

from .controller import invert_jacobian
from .models import LocalCalibration, RevisionSnapshot


MIN_FIT_SAMPLES = 4
MIN_VALIDATION_SAMPLES = 2
MAX_SAMPLES_PER_SET = 100
MAX_ABS_ANGLE_DELTA_DEG = 45.0
MIN_AXIS_SPAN_DEG = 0.1
MAX_ABS_PIXEL_DELTA = 10_000.0
MAX_DESIGN_CONDITION = 20.0
MAX_FIT_RMS_RESIDUAL_PX = 3.0
MAX_FIT_RESIDUAL_PX = 5.0
MAX_VALIDATION_RMS_RESIDUAL_PX = 3.0
MAX_VALIDATION_RESIDUAL_PX = 5.0

CalibrationSource = Literal["user_supplied", "synthetic"]


@dataclass(frozen=True, slots=True)
class JacobianSample:
    """One recorded motion and corresponding image displacement, tied to revisions."""

    yaw_deg: float
    pitch_deg: float
    dx_px: float
    dy_px: float
    circuit_revision: str | None
    firmware_revision: str | None
    calibration_revision: str

    def __post_init__(self) -> None:
        numbers = (self.yaw_deg, self.pitch_deg, self.dx_px, self.dy_px)
        for value in numbers:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("calibration sample values must be finite numbers")
            try:
                finite = math.isfinite(float(value))
            except (OverflowError, TypeError, ValueError):
                finite = False
            if not finite:
                raise ValueError("calibration sample values must be finite numbers")
        if abs(self.yaw_deg) > MAX_ABS_ANGLE_DELTA_DEG or abs(self.pitch_deg) > MAX_ABS_ANGLE_DELTA_DEG:
            raise ValueError("sample angle deltas must be within +/-45 degrees")
        if abs(self.dx_px) > MAX_ABS_PIXEL_DELTA or abs(self.dy_px) > MAX_ABS_PIXEL_DELTA:
            raise ValueError("sample pixel deltas must be within +/-10000 pixels")
        if not isinstance(self.calibration_revision, str) or not self.calibration_revision or len(self.calibration_revision) > 128:
            raise ValueError("sample calibration revision must contain 1 to 128 characters")
        if self.circuit_revision is not None and (not isinstance(self.circuit_revision, str) or not self.circuit_revision or len(self.circuit_revision) > 128):
            raise ValueError("sample circuit revision must be null or 1 to 128 characters")
        if self.firmware_revision is not None and (not isinstance(self.firmware_revision, str) or not self.firmware_revision or len(self.firmware_revision) > 128):
            raise ValueError("sample firmware revision must be null or 1 to 128 characters")

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> JacobianSample:
        required = {"yaw_deg", "pitch_deg", "dx_px", "dy_px", "circuit_revision",
                    "firmware_revision", "calibration_revision"}
        if set(value) != required:
            raise ValueError("sample must contain the four deltas and all three revision labels")
        try:
            return cls(**value)  # type: ignore[arg-type]
        except TypeError as error:
            raise ValueError("sample fields have invalid types") from error


@dataclass(frozen=True, slots=True)
class CalibrationFit:
    status: Literal["accepted", "rejected"]
    calibration: LocalCalibration | None
    revisions: RevisionSnapshot
    data_source: CalibrationSource
    fit_sample_count: int
    validation_sample_count: int
    fit_rms_residual_px: float | None
    validation_rms_residual_px: float | None
    validation_max_residual_px: float | None
    design_condition_number: float | None
    validation_design_condition_number: float | None
    rejection_reasons: tuple[str, ...]
    limitations: tuple[str, ...]
    physical_verification: Literal["pending"] = "pending"
    hardware_armed: Literal[False] = False


def _normalize_samples(
    samples: Sequence[JacobianSample | Mapping[str, object]], expected: RevisionSnapshot, *, label: str
) -> list[JacobianSample]:
    if isinstance(samples, (str, bytes)) or not isinstance(samples, Sequence):
        raise ValueError(f"{label} samples must be a bounded sequence")
    if len(samples) > MAX_SAMPLES_PER_SET:
        raise ValueError(f"{label} sample count exceeds {MAX_SAMPLES_PER_SET}")
    normalized: list[JacobianSample] = []
    for sample in samples:
        if isinstance(sample, JacobianSample):
            item = sample
        elif isinstance(sample, Mapping):
            item = JacobianSample.from_mapping(sample)
        else:
            raise ValueError(f"{label} entries must be JacobianSample objects or mappings")
        if (item.circuit_revision, item.firmware_revision, item.calibration_revision) != (
            expected.circuit_revision, expected.firmware_revision, expected.calibration_revision
        ):
            raise ValueError(f"{label} sample revision metadata does not match the requested revision snapshot")
        normalized.append(item)
    return normalized


def _condition_number(aa: float, ab: float, bb: float) -> tuple[float, float]:
    discriminant = math.sqrt(max(0.0, (aa - bb) ** 2 + 4.0 * ab * ab))
    largest = (aa + bb + discriminant) / 2.0
    smallest = (aa + bb - discriminant) / 2.0
    if smallest <= 1e-15 or largest <= 0:
        return math.inf, 0.0
    return math.sqrt(largest / smallest), smallest


def _predict(jacobian: tuple[tuple[float, float], tuple[float, float]], sample: JacobianSample) -> tuple[float, float]:
    return (
        jacobian[0][0] * sample.yaw_deg + jacobian[0][1] * sample.pitch_deg,
        jacobian[1][0] * sample.yaw_deg + jacobian[1][1] * sample.pitch_deg,
    )


def fit_local_calibration(
    fit_samples: Sequence[JacobianSample | Mapping[str, object]],
    validation_samples: Sequence[JacobianSample | Mapping[str, object]],
    *,
    revisions: RevisionSnapshot,
    data_source: CalibrationSource,
) -> CalibrationFit:
    """Fit and held-out validate a local 2x2 image Jacobian without device access.

    Samples are motion deltas from one local calibration origin. The fitted model
    has no intercept: image displacement is modeled as J @ (yaw, pitch).
    """
    if not isinstance(revisions, RevisionSnapshot):
        raise ValueError("revisions must be a RevisionSnapshot")
    for name, revision in (("circuit_revision", revisions.circuit_revision),
                           ("firmware_revision", revisions.firmware_revision),
                           ("calibration_revision", revisions.calibration_revision)):
        if revision is not None and (not isinstance(revision, str) or not revision or len(revision) > 128):
            raise ValueError(f"{name} must be null or a string of 1 to 128 characters")
    if data_source not in ("user_supplied", "synthetic"):
        raise ValueError("data_source must explicitly be user_supplied or synthetic")
    fit = _normalize_samples(fit_samples, revisions, label="fit")
    validation = _normalize_samples(validation_samples, revisions, label="validation")
    reasons: list[str] = []
    if len(fit) < MIN_FIT_SAMPLES:
        reasons.append(f"at least {MIN_FIT_SAMPLES} independent fit samples are required")
    if len(validation) < MIN_VALIDATION_SAMPLES:
        reasons.append(f"at least {MIN_VALIDATION_SAMPLES} held-out validation samples are required")
    if set(fit).intersection(validation):
        reasons.append("held-out validation samples must not reuse exact fit sample records")
    base = dict(
        revisions=revisions,
        data_source=data_source,
        fit_sample_count=len(fit),
        validation_sample_count=len(validation),
        fit_rms_residual_px=None,
        validation_rms_residual_px=None,
        validation_max_residual_px=None,
        design_condition_number=None,
        validation_design_condition_number=None,
        limitations=(
            "Only user-supplied or synthetic deltas are analyzed; this routine does not capture sensor data.",
            "Direction-dependent backlash, hysteresis, repeatability, lens distortion, and workspace variation were not characterized.",
            "Physical verification remains pending; this result never arms hardware or enables emission.",
        ),
    )
    if reasons:
        return CalibrationFit(status="rejected", calibration=None, rejection_reasons=tuple(reasons), **base)

    validation_condition: float | None = None
    validation_yaw_span = max(sample.yaw_deg for sample in validation) - min(sample.yaw_deg for sample in validation)
    validation_pitch_span = max(sample.pitch_deg for sample in validation) - min(sample.pitch_deg for sample in validation)
    nonzero_validation = [sample for sample in validation if math.hypot(sample.yaw_deg, sample.pitch_deg) > 1e-12]
    if len(nonzero_validation) < 2:
        reasons.append("held-out validation needs at least two independent nonzero motion vectors")
    if validation_yaw_span < MIN_AXIS_SPAN_DEG or validation_pitch_span < MIN_AXIS_SPAN_DEG:
        reasons.append("held-out validation must excite both yaw and pitch by at least 0.1 degrees")
    vaa = sum(sample.yaw_deg ** 2 for sample in validation)
    vab = sum(sample.yaw_deg * sample.pitch_deg for sample in validation)
    vbb = sum(sample.pitch_deg ** 2 for sample in validation)
    validation_condition_value, _ = _condition_number(vaa, vab, vbb)
    if math.isfinite(validation_condition_value):
        validation_condition = validation_condition_value
        if validation_condition_value > MAX_DESIGN_CONDITION:
            reasons.append(f"held-out direction condition number exceeds {MAX_DESIGN_CONDITION:g}")
    else:
        reasons.append("held-out sample directions are singular or collinear")

    if reasons:
        return CalibrationFit(status="rejected", calibration=None, rejection_reasons=tuple(reasons),
                              **{**base, "validation_design_condition_number": validation_condition})

    yaw_span = max(sample.yaw_deg for sample in fit) - min(sample.yaw_deg for sample in fit)
    pitch_span = max(sample.pitch_deg for sample in fit) - min(sample.pitch_deg for sample in fit)
    if yaw_span < MIN_AXIS_SPAN_DEG or pitch_span < MIN_AXIS_SPAN_DEG:
        reasons.append("fit samples must cover both yaw and pitch axes independently")

    aa = sum(sample.yaw_deg ** 2 for sample in fit)
    ab = sum(sample.yaw_deg * sample.pitch_deg for sample in fit)
    bb = sum(sample.pitch_deg ** 2 for sample in fit)
    condition, smallest_eigenvalue = _condition_number(aa, ab, bb)
    if not math.isfinite(condition):
        reasons.append("fit sample directions are singular or collinear")
    elif condition > MAX_DESIGN_CONDITION:
        reasons.append(f"fit direction condition number exceeds {MAX_DESIGN_CONDITION:g}")

    det = aa * bb - ab * ab
    if not math.isfinite(det) or det <= 1e-15:
        reasons.append("fit design matrix is rank deficient")
    if reasons:
        return CalibrationFit(status="rejected", calibration=None, rejection_reasons=tuple(reasons),
                              **{**base,
                                 "design_condition_number": condition if math.isfinite(condition) else None,
                                 "validation_design_condition_number": validation_condition})

    inv00, inv01, inv11 = bb / det, -ab / det, aa / det
    coefficients = []
    for output in ("dx_px", "dy_px"):
        cross_yaw = sum(sample.yaw_deg * getattr(sample, output) for sample in fit)
        cross_pitch = sum(sample.pitch_deg * getattr(sample, output) for sample in fit)
        coefficients.append((inv00 * cross_yaw + inv01 * cross_pitch,
                             inv01 * cross_yaw + inv11 * cross_pitch))
    jacobian = (coefficients[0], coefficients[1])
    if any(not math.isfinite(value) or abs(value) > 100_000 for row in jacobian for value in row):
        return CalibrationFit(status="rejected", calibration=None,
                              rejection_reasons=("fitted Jacobian coefficients are non-finite or out of range",),
                              **{**base,
                                 "design_condition_number": condition if math.isfinite(condition) else None,
                                 "validation_design_condition_number": validation_condition})

    fit_errors = [math.dist(_predict(jacobian, sample), (sample.dx_px, sample.dy_px)) for sample in fit]
    validation_errors = [math.dist(_predict(jacobian, sample), (sample.dx_px, sample.dy_px)) for sample in validation]
    fit_rms = math.sqrt(sum(error * error for error in fit_errors) / len(fit_errors))
    fit_max = max(fit_errors)
    validation_rms = math.sqrt(sum(error * error for error in validation_errors) / len(validation_errors))
    validation_max = max(validation_errors)
    if fit_rms > MAX_FIT_RMS_RESIDUAL_PX:
        reasons.append(f"fit RMS residual exceeds {MAX_FIT_RMS_RESIDUAL_PX:g} pixels")
    if fit_max > MAX_FIT_RESIDUAL_PX:
        reasons.append(f"fit maximum residual exceeds {MAX_FIT_RESIDUAL_PX:g} pixels")
    if validation_rms > MAX_VALIDATION_RMS_RESIDUAL_PX:
        reasons.append(f"held-out RMS residual exceeds {MAX_VALIDATION_RMS_RESIDUAL_PX:g} pixels")
    if validation_max > MAX_VALIDATION_RESIDUAL_PX:
        reasons.append(f"held-out maximum residual exceeds {MAX_VALIDATION_RESIDUAL_PX:g} pixels")

    calibration: LocalCalibration | None = None
    if not reasons:
        calibration = LocalCalibration(
            calibration_revision=revisions.calibration_revision,
            jacobian_px_per_degree=jacobian,
            max_condition_number=MAX_DESIGN_CONDITION,
            residual_px=validation_max,
            valid=True,
        )
        try:
            invert_jacobian(calibration)
        except ValueError as error:
            calibration = None
            reasons.append(f"fitted Jacobian is not controller-usable: {error}")

    return CalibrationFit(
        status="accepted" if calibration is not None else "rejected",
        calibration=calibration,
        rejection_reasons=tuple(reasons),
        **{
            **base,
            "fit_rms_residual_px": fit_rms,
            "validation_rms_residual_px": validation_rms,
            "validation_max_residual_px": validation_max,
            "design_condition_number": condition if math.isfinite(condition) else None,
            "validation_design_condition_number": validation_condition,
        },
    )
