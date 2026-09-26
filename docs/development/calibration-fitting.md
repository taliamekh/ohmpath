# Local Jacobian calibration fitting

`ohmpath_pi.calibration.fit_local_calibration(fit_samples, validation_samples, *, revisions, data_source) -> CalibrationFit` fits the local linear mapping from small commanded image-space sample deltas to observed pixel deltas:

```text
[dx_px]   [du/dyaw  du/dpitch] [yaw_deg]
[dy_px] = [dv/dyaw  dv/dpitch] [pitch_deg]
```

The function performs offline arithmetic only. Callers provide separate fit and held-out validation samples. Each sample is a `JacobianSample` or mapping with exactly `yaw_deg`, `pitch_deg`, `dx_px`, `dy_px`, `circuit_revision`, `firmware_revision`, and `calibration_revision`. All samples must match the provided `RevisionSnapshot`. `data_source` is required and is either `user_supplied` or `synthetic`; the result preserves that label.

A candidate fit requires at least four fit points spanning both axes and two held-out points that independently excite both axes. Both fit and validation design matrices must be full rank with condition number no greater than 20. Exact fit records cannot be reused as validation records. Fit and held-out RMS error must be no greater than 3 px, with fit and held-out maximum error no greater than 5 px. Values are bounded to ±45 degrees and ±10,000 pixels; each set is capped at 100 samples. A successful result contains `LocalCalibration` bound to `revisions.calibration_revision`, using the existing controller Jacobian and residual checks. Singular/collinear diagnostic condition values are represented as null so results remain finite JSON. A rejected fit always has `calibration=None` and one or more rejection reasons. Non-finite data, malformed fields, and revision mismatches raise `ValueError` before fitting.

The returned status is a fit result only. `physical_verification` remains `pending`, `hardware_armed` is always false, and limitations call out direction-dependent backlash, hysteresis, repeatability, lens distortion, and workspace variation. The `LocalCalibration` dataclass is not evidence that a camera measured the supplied values, and this function does not open the camera or send a command. Synthetic values should remain labeled synthetic and must not be presented as physical calibration.

Focused tests use a known cross-coupled matrix, singular and single-axis fit/validation data, zero-motion validation, reused records, corrupted held-out data, noise, non-finite input, malformed sample types, revision mismatch, and insufficient samples. They invoke no camera, network, GPIO, PWM, motor, or laser.
