from __future__ import annotations

import pytest

from ohmpath_pi.calibration import JacobianSample, fit_local_calibration
from ohmpath_pi.models import RevisionSnapshot


REVISIONS = RevisionSnapshot("circuit-r7", "firmware-r2", "calibration-r4")
KNOWN = ((12.0, 3.0), (-2.0, 15.0))


def sample(yaw, pitch, *, noise_x=0.0, noise_y=0.0, revisions=REVISIONS):
    return JacobianSample(
        yaw, pitch,
        KNOWN[0][0] * yaw + KNOWN[0][1] * pitch + noise_x,
        KNOWN[1][0] * yaw + KNOWN[1][1] * pitch + noise_y,
        revisions.circuit_revision, revisions.firmware_revision, revisions.calibration_revision,
    )


def test_cross_coupled_jacobian_fit_uses_held_out_samples_and_revision_binding():
    fit = [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1), sample(1, 1)]
    held_out = [sample(2, 1, noise_x=0.1), sample(-1, 2, noise_y=-0.1)]

    result = fit_local_calibration(fit, held_out, revisions=REVISIONS, data_source="user_supplied")

    assert result.status == "accepted"
    assert result.calibration is not None
    fitted = result.calibration.jacobian_px_per_degree
    assert fitted[0] == pytest.approx(KNOWN[0])
    assert fitted[1] == pytest.approx(KNOWN[1])
    assert result.revisions == REVISIONS
    assert result.data_source == "user_supplied"
    assert result.validation_sample_count == 2
    assert result.validation_max_residual_px < 0.2
    assert result.physical_verification == "pending"
    assert result.hardware_armed is False
    assert any("backlash" in note for note in result.limitations)


def test_singular_collinear_and_single_axis_samples_never_produce_calibration():
    collinear = [sample(i, 2 * i) for i in (-2, -1, 1, 2)]
    held_out = [sample(0.5, 1), sample(1.5, -1)]
    result = fit_local_calibration(collinear, held_out, revisions=REVISIONS, data_source="synthetic")
    assert result.status == "rejected"
    assert result.calibration is None
    assert result.design_condition_number is None
    assert any("singular" in reason or "rank deficient" in reason for reason in result.rejection_reasons)

    single_axis = [sample(i, 0) for i in (-2, -1, 1, 2)]
    result = fit_local_calibration(single_axis, held_out, revisions=REVISIONS, data_source="synthetic")
    assert result.calibration is None
    assert any("both yaw and pitch" in reason for reason in result.rejection_reasons)


def test_corrupted_held_out_point_and_noisy_fit_are_rejected():
    fit = [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1)]
    corrupted = [sample(1, 1, noise_x=10), sample(-1, 2)]
    result = fit_local_calibration(fit, corrupted, revisions=REVISIONS, data_source="user_supplied")
    assert result.status == "rejected"
    assert result.calibration is None
    assert any("held-out" in reason for reason in result.rejection_reasons)

    noisy = [sample(1, 0, noise_x=8), sample(-1, 0, noise_x=-8),
             sample(0, 1, noise_y=8), sample(0, -1, noise_y=-8)]
    result = fit_local_calibration(noisy, [sample(1, 1), sample(-1, -2)],
                                   revisions=REVISIONS, data_source="user_supplied")
    assert result.calibration is None
    assert any("RMS residual" in reason for reason in result.rejection_reasons)


def test_nonfinite_values_and_mismatched_revision_metadata_are_rejected():
    with pytest.raises(ValueError, match="finite"):
        JacobianSample(float("nan"), 0, 1, 2, "circuit-r7", "firmware-r2", "calibration-r4")
    with pytest.raises(ValueError, match="revision metadata"):
        fit_local_calibration(
            [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1)],
            [sample(1, 1), sample(-1, 1, revisions=RevisionSnapshot("other", "firmware-r2", "calibration-r4"))],
            revisions=REVISIONS, data_source="user_supplied",
        )


def test_insufficient_samples_are_rejected_without_fabricating_calibration():
    result = fit_local_calibration([sample(1, 0)], [sample(0, 1)],
                                   revisions=REVISIONS, data_source="synthetic")
    assert result.status == "rejected"
    assert result.calibration is None
    assert result.fit_sample_count == 1
    assert result.validation_sample_count == 1
    assert result.physical_verification == "pending"
    assert result.hardware_armed is False


def test_held_out_zero_motion_and_collinear_samples_are_rejected():
    fit = [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1)]
    zero_validation = [sample(0, 0), sample(0, 0)]
    result = fit_local_calibration(fit, zero_validation, revisions=REVISIONS, data_source="synthetic")
    assert result.calibration is None
    assert result.validation_design_condition_number is None
    assert any("nonzero motion" in reason for reason in result.rejection_reasons)

    collinear_validation = [sample(1, 1), sample(2, 2)]
    result = fit_local_calibration(fit, collinear_validation, revisions=REVISIONS, data_source="synthetic")
    assert result.calibration is None
    assert result.validation_design_condition_number is None
    assert any("collinear" in reason or "condition number" in reason for reason in result.rejection_reasons)


def test_validation_samples_must_be_held_out_and_independent():
    fit = [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1)]
    reused = [fit[0], sample(2, 1)]
    result = fit_local_calibration(fit, reused, revisions=REVISIONS, data_source="user_supplied")
    assert result.calibration is None
    assert any("reuse exact fit" in reason for reason in result.rejection_reasons)

    weakly_independent = [sample(1.0, 1.0), sample(1.11, 1.1)]
    result = fit_local_calibration(fit, weakly_independent, revisions=REVISIONS, data_source="synthetic")
    assert result.calibration is None
    assert result.validation_design_condition_number is not None
    assert result.validation_design_condition_number > 20
    assert any("held-out direction condition number" in reason for reason in result.rejection_reasons)


def test_malformed_sample_and_integer_revision_metadata_raise_value_error():
    fit = [sample(1, 0), sample(-1, 0), sample(0, 1), sample(0, -1)]
    held_out = [sample(2, 1), sample(1, 2)]
    with pytest.raises(ValueError, match="entries must"):
        fit_local_calibration([*fit[:3], 123], held_out, revisions=REVISIONS, data_source="synthetic")
    with pytest.raises(ValueError, match="calibration_revision"):
        invalid_revisions = RevisionSnapshot("circuit-r7", "firmware-r2", 12)  # type: ignore[arg-type]
        fit_local_calibration(fit, held_out, revisions=invalid_revisions, data_source="synthetic")
    with pytest.raises(ValueError, match="calibration revision"):
        JacobianSample(1, 0, 12, -2, "circuit-r7", "firmware-r2", 4)  # type: ignore[arg-type]
