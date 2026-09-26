# Calibration and circuit-runner review

Review scope: `services/pi/src/ohmpath_pi/calibration.py`, its controller and
model use, focused Pi tests, and the current circuit graph and ngspice runner.
This was source review and local testing only; no camera, motor, GPIO, laser,
or physical circuit was used.

The fitted Jacobian uses image pixels per degree in the documented row/column
order: `((du/dyaw, du/dpitch), (dv/dyaw, dv/dpitch))`. The no-intercept least
squares fit solves both output rows against yaw/pitch motion deltas. The
controller's 2-by-2 inverse maps pixel error back to degree requests in the
same order and limits each axis before returning mock-only setpoints. The
known cross-coupled fit and simulated closed-loop plant tests exercise this
orientation. Fit and held-out residuals are Euclidean pixel errors; the
controller rejects residuals above five pixels and singular/ill-conditioned
Jacobian matrices.

Sample records require finite bounded deltas and exact circuit, firmware,
and calibration revision labels matching the requested snapshot. A mismatch
raises before any fit is accepted. The fit result keeps the full revision
snapshot and an explicit `user_supplied` or `synthetic` source label; every
result remains `physical_verification="pending"` and `hardware_armed=False`.
These source labels describe what the caller supplied, not independently
authenticated camera or actuator data. The only bundled Pi motor driver is
mock and physical emission is hard-disabled.

The worker's held-out hardening requires independent yaw/pitch excitation,
rejects rank-deficient or ill-conditioned validation directions, and rejects
exact reuse of fit samples in validation. A mid-edit review found a missing
`validation_design_condition_number` constructor argument that caused four
focused tests to fail; the worker corrected it before handoff. The finalized
calibration, Pi-link, deployment, ngspice, and KiCad focused suite passed.

One future integration boundary needs explicit treatment: `CalibrationFit`
retains circuit and firmware revisions, but its contained `LocalCalibration`
stores only the calibration revision. `CrosshairController.update` checks a
new observation against an expected full snapshot and checks the calibration
revision, but it cannot itself prove that an extracted `LocalCalibration`
was fitted under the same circuit and firmware revisions. Current use is
mock-only; any physical-motion integration must pass and verify the full fit
snapshot, rather than reusing a bare calibration with the same calibration
label. An accepted numerical fit is not physical clearance.

The circuit graph now bounds the component count at 128 and accepts only
registered resistor and DC-source models. The runner generates its own DC
netlist, limits execution time and output size, reports `provenance="none"`
when ngspice is absent, and returns no voltages for failed, timed-out, or
cancelled runs. Successful status requires parsed voltages for each requested
non-ground node and rejects convergence/fatal messages even with exit code
zero. I investigated a possible ground-node parser issue and ruled it out:
ground nodes are excluded from the alias map, so an extra `v(0)` line is
ignored and cannot conceal an omitted requested node. The final parser also
states this requirement directly with `requested.issubset(found)`.

The focused command
`.venv/Scripts/python.exe -m pytest services/pi/tests/test_calibration_fit.py services/pi/tests/test_deployment_package.py services/bench/tests/test_pi_link.py services/bench/tests/test_circuits.py services/bench/tests/test_circuits_kicad.py -q`
passed **68 tests** after the worker handoff. No blocking defect remains in
this reviewed mock/calculation path. No application code was changed in this
review; only this note was added. No contract change. The future revision
handoff and physical calibration gates above remain unverified. Proposed
plain-English commit title: `Document calibration and simulator review`.
