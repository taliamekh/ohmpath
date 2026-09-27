"""Local camera calibration against a synthetic mechanism with direction backlash."""
from copy import deepcopy
from types import SimpleNamespace
import time

import numpy as np
import pytest

from ohmpath.devices.turret import Turret
from ohmpath.devices.turret_vision import advance_camera_map, correction, fit_camera_map


MATRIX = np.array([[.7, .15], [-.12, .42]])
PROFILE = {'yaw': {'min': 1380, 'max': 2055, 'home': 1500},
           'pitch': {'min': 1500, 'max': 2492, 'home': 2004}}


def mechanism(tmp_path, monkeypatch, start=(1700, 2000), response='linear'):
    """Replace only observation/movement boundaries; production calibration runs."""
    turret = Turret(tmp_path)
    turret.profile = deepcopy(PROFILE)
    turret.video = SimpleNamespace(generation='synthetic-camera')
    turret.presence = time.monotonic()
    turret.state = {'armed': True, 'moving': False, 'driving': False,
                    'revision': 'saved-endpoints', 'firmware_revision': 'synthetic',
                    'commanded_us': dict(zip(('yaw', 'pitch'), start)),
                    'target_us': dict(zip(('yaw', 'pitch'), start))}
    frame = {'image': np.zeros((1280, 720, 3), dtype=np.uint8),
             'generation': 'synthetic-camera', 'sequence': 0}
    # A direction reversal consumes twice this play before the shaft follows.
    play = np.array([7., 10.])
    effective = np.array(start, dtype=float) - play
    origin = effective.copy()
    commands = []
    observations = []

    def observe():
        frame['sequence'] += 1
        if response == 'frozen':
            point = np.array([350., 640.])
        else:
            displacement = effective - origin
            if response == 'yaw_frozen':
                displacement[0] = 0
            if response == 'pitch_frozen':
                displacement[1] = 0
            point = np.array([350., 640.]) + MATRIX @ displacement
            if response == 'unstable':
                # Successive equal commands yield materially different readings.
                point += np.array([8., -6.]) * (1 if len(commands) % 2 else -1)
            if response == 'command_correlated_drift':
                # A separate limitation case: this stays constant between moves.
                point += np.array([5., -4.]) * len(commands) ** 2
        turret.point = point.copy()
        turret.point_sequence = frame['sequence']
        observations.append(point.copy())
        return point

    def move(target, cancel):
        nonlocal effective
        turret._check_job(cancel)
        checked = {axis: float(target[axis]) for axis in ('yaw', 'pitch')}
        previous = turret.state['commanded_us']
        for axis, value in checked.items():
            assert PROFILE[axis]['min'] <= value <= PROFILE[axis]['max']
            assert abs(value - previous[axis]) <= 100
        commanded = np.array([checked['yaw'], checked['pitch']])
        effective = np.maximum(commanded - play, np.minimum(effective, commanded + play))
        commands.append(checked)
        turret.state.update(commanded_us=dict(checked), target_us=dict(checked))
        turret.presence = time.monotonic()
        return observe()

    monkeypatch.setattr(turret, '_frame', lambda: frame)
    monkeypatch.setattr(turret, '_settle', lambda cancel: observe())
    monkeypatch.setattr(turret, '_move', move)
    observe()
    return turret, commands, observations


def test_direction_preload_calibrates_backlash_without_assuming_return_home(tmp_path, monkeypatch):
    turret, commands, observations = mechanism(tmp_path, monkeypatch)
    context = turret._context()

    turret._calibrate(turret.job_cancel)

    np.testing.assert_allclose(turret.calibration['matrix'], MATRIX, atol=1e-8)
    assert turret.calibration['context'] == context
    assert turret.calibration['origin_us'] == commands[-1] == turret.state['commanded_us']
    assert turret.calibration['evidence_kind'] == 'camera_observation'
    assert turret.calibration['sampling_method'] == 'consecutive_after_preload'
    assert turret.calibration['pixel_scale'] == 2  # 1280-pixel portrait frame.
    assert turret.calibration['fit_error_px'] < 1e-8
    assert turret.calibration['validation_error_px'] < 1e-8
    np.testing.assert_array_equal(turret.point, observations[-1])
    assert turret.control is None


@pytest.mark.parametrize('start', [(1380, 1500), (1380, 2492), (2055, 1500), (2055, 2492)])
def test_backlash_calibration_stays_inside_learned_limits_at_corners(tmp_path, monkeypatch, start):
    turret, commands, _ = mechanism(tmp_path, monkeypatch, start)

    turret._calibrate(turret.job_cancel)

    assert commands
    np.testing.assert_allclose(turret.calibration['matrix'], MATRIX, atol=1e-8)
    assert turret.calibration['origin_us'] == commands[-1]
    assert turret._calibration_valid()


@pytest.mark.parametrize('response', ['frozen', 'yaw_frozen', 'pitch_frozen', 'unstable'])
def test_backlash_calibration_rejects_unobservable_or_unstable_response(tmp_path, monkeypatch, response):
    turret, commands, _ = mechanism(tmp_path, monkeypatch, response=response)

    with pytest.raises(ValueError):
        turret._calibrate(turret.job_cancel)

    assert commands
    assert turret.calibration is None
    assert turret.control is None


def test_changed_camera_context_cannot_publish_backlash_calibration(tmp_path, monkeypatch):
    turret, commands, _ = mechanism(tmp_path, monkeypatch)
    move = turret._move

    def changed_view(target, cancel):
        point = move(target, cancel)
        turret.video.generation = 'replacement-camera'
        return point

    monkeypatch.setattr(turret, '_move', changed_view)
    with pytest.raises(ValueError, match='Camera or travel settings changed'):
        turret._calibrate(turret.job_cancel)

    assert commands
    assert turret.calibration is None


def test_observation_only_fit_cannot_disambiguate_command_correlated_scene_drift(tmp_path, monkeypatch):
    """A fitting local model is not independent proof of servo or beam position.

    This bias changes only with commands, so a stationary-settling check cannot
    detect it. Its sampled residuals meet the local feedback-model contract even
    though its matrix differs from the mechanism. Fresh convergence observations
    remain necessary; this test documents the limitation rather than accuracy.
    """
    turret, _, _ = mechanism(tmp_path, monkeypatch, response='command_correlated_drift')

    turret._calibrate(turret.job_cancel)

    result = turret.calibration
    assert not np.allclose(result['matrix'], MATRIX, rtol=.2, atol=.1)
    assert result['fit_error_px'] <= 4 * result['pixel_scale']
    assert result['validation_error_px'] <= result['validation_limit_px']


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_camera_map_errors_scale_with_resolution_without_changing_jacobian(pixel_scale):
    offsets = [np.array(pair) for pair in ((20, 0), (20, 0), (0, 50), (0, 50))]
    noise = [np.array([sign * 3., 0.]) for sign in (1, -1, 1, -1)]
    samples = [(offset, (MATRIX @ offset + error) * pixel_scale)
               for offset, error in zip(offsets, noise)]
    held_out = np.array([10., 25.])
    observed = (MATRIX @ held_out + np.array([0., 4.8])) * pixel_scale

    result = fit_camera_map(samples, (held_out, observed), pixel_scale=pixel_scale)

    np.testing.assert_allclose(np.array(result['matrix']) / pixel_scale, MATRIX, atol=1e-8)
    assert result['fit_error_px'] / pixel_scale == pytest.approx(3.)
    assert result['validation_error_px'] / pixel_scale == pytest.approx(4.8)
    assert result['pixel_scale'] == pixel_scale
    with pytest.raises(ValueError, match='not repeatable'):
        fit_camera_map(samples, (held_out, (MATRIX @ held_out + [0., 6.]) * pixel_scale),
                       pixel_scale=pixel_scale)


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_resolution_scaling_does_not_accept_an_unobservable_axis(pixel_scale):
    offsets = [np.array(pair) for pair in ((20, 0), (20, 0), (0, 50), (0, 50))]
    almost_stuck = np.array([[.1, 0.], [0., .02]]) * pixel_scale
    samples = [(offset, almost_stuck @ offset) for offset in offsets]
    held_out = np.array([10., 25.])

    with pytest.raises(ValueError, match='too small or ambiguous'):
        fit_camera_map(samples, (held_out, almost_stuck @ held_out), pixel_scale=pixel_scale)


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_large_validation_step_accepts_bounded_relative_error_only(pixel_scale):
    matrix = np.array([[1.3, .1], [-.2, 1.6]]) * pixel_scale
    offsets = [np.array(pair) for pair in ((20, 0), (20, 0), (0, 50), (0, 50))]
    samples = [(offset, matrix @ offset) for offset in offsets]
    held_out = np.array([20., 50.])
    prediction = matrix @ held_out

    result = fit_camera_map(samples, (held_out, .84 * prediction), pixel_scale=pixel_scale)

    assert result['validation_error_px'] > 5 * pixel_scale
    assert result['validation_error_px'] == pytest.approx(.16 * np.linalg.norm(prediction))
    assert result['validation_limit_px'] == pytest.approx(.2 * np.linalg.norm(prediction))
    with pytest.raises(ValueError, match='not repeatable'):
        fit_camera_map(samples, (held_out, .79 * prediction), pixel_scale=pixel_scale)


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_recorded_step_variation_fits_local_feedback_model_at_each_resolution(pixel_scale):
    # Numerical replay of the supplied observation log, not a physical test.
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    observed = np.array([[20.409, .632], [20.108, 2.465],
                         [1.422, -87.287], [2.905, -71.143]]) * pixel_scale / 2
    held_out = np.array([20., 50.])
    validation = np.array([27.896, -73.692]) * pixel_scale / 2

    result = fit_camera_map(list(zip(offsets, observed)), (held_out, validation), pixel_scale=pixel_scale)

    predictions = offsets @ np.array(result['matrix']).T
    errors = np.linalg.norm(observed - predictions, axis=1)
    # Pitch clears the former absolute bound but remains below 12.5% of its
    # own fitted movement. Its larger allowance does not apply to yaw.
    assert errors[2] > 4 * pixel_scale
    assert errors[2] / np.linalg.norm(predictions[2]) == pytest.approx(.1022908, abs=1e-6)
    assert result['fit_error_px'] == pytest.approx(8.1059858284 * pixel_scale / 2)
    assert result['validation_error_px'] == pytest.approx(6.7647118379 * pixel_scale / 2)
    assert result['validation_error_px'] < result['validation_limit_px']


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_larger_pitch_response_does_not_hide_unstable_small_yaw_steps(pixel_scale):
    matrix = np.diag([.5, 1.6]) * pixel_scale
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    outputs = offsets @ matrix.T
    # 4.5px exceeds yaw's 4px floor but is smaller than pitch's 10px allowance.
    outputs[:2, 1] += np.array([4.5, -4.5]) * pixel_scale
    held_out = np.array([20., 50.])

    with pytest.raises(ValueError, match='not repeatable'):
        fit_camera_map(list(zip(offsets, outputs)), (held_out, matrix @ held_out), pixel_scale=pixel_scale)


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_relative_repeatability_bound_still_rejects_large_step_instability(pixel_scale):
    matrix = np.diag([1.2, 1.6]) * pixel_scale
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    predicted = offsets @ matrix.T
    held_out = np.array([20., 50.])
    for fraction in (.124, .126):
        outputs = predicted.copy()
        outputs[2:, 0] += np.array([1., -1.]) * fraction * np.linalg.norm(predicted[2])
        samples = list(zip(offsets, outputs))
        if fraction < .125:
            result = fit_camera_map(samples, (held_out, matrix @ held_out), pixel_scale=pixel_scale)
            np.testing.assert_allclose(result['matrix'], matrix, atol=1e-12)
        else:
            with pytest.raises(ValueError, match='not repeatable'):
                fit_camera_map(samples, (held_out, matrix @ held_out), pixel_scale=pixel_scale)


def test_relative_fit_tolerance_does_not_accept_ill_conditioned_axes():
    matrix = np.diag([1., 21.])
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    held_out = np.array([20., 50.])
    with pytest.raises(ValueError, match='too small or ambiguous'):
        fit_camera_map([(step, matrix @ step) for step in offsets],
                       (held_out, matrix @ held_out))


@pytest.mark.parametrize('field', [0, 1])
@pytest.mark.parametrize('bad_value', [np.nan, np.inf])
def test_relative_fit_tolerance_still_rejects_nonfinite_samples(field, bad_value):
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    samples = [[step.copy(), MATRIX @ step] for step in offsets]
    samples[0][field][0] = bad_value
    held_out = np.array([20., 50.])
    with pytest.raises(ValueError, match='incomplete'):
        fit_camera_map(samples, (held_out, MATRIX @ held_out))


@pytest.mark.parametrize('pixel_scale', [1., 2., 4.])
def test_feedback_model_tolerance_does_not_enlarge_six_pixel_arrival_region(pixel_scale):
    matrix = MATRIX * pixel_scale
    offsets = np.array([[20., 0.], [20., 0.], [0., 50.], [0., 50.]])
    held_out = np.array([20., 50.])
    mapping = fit_camera_map([(step, matrix @ step) for step in offsets],
                             (held_out, matrix @ held_out), pixel_scale=pixel_scale)
    current = {'yaw': 1700., 'pitch': 2000.}
    centre = np.array([359.5, 639.5])

    target, aligned = correction(mapping, centre + [6., 0.], (720, 1280), current, PROFILE)
    assert aligned and target == current
    target, aligned = correction(mapping, centre + [6.01, 0.], (720, 1280), current, PROFILE)
    assert not aligned and target != current


@pytest.mark.parametrize('field', [0, 1])
@pytest.mark.parametrize('bad_value', [np.nan, np.inf])
def test_nonfinite_held_out_step_cannot_be_accepted_as_calibration(field, bad_value):
    offsets = [np.array(pair) for pair in ((20, 0), (20, 0), (0, 50), (0, 50))]
    samples = [(offset, MATRIX @ offset) for offset in offsets]
    held_out = np.array([20., 50.])
    validation = [held_out.copy(), MATRIX @ held_out]
    validation[field][0] = bad_value

    with pytest.raises(ValueError):
        fit_camera_map(samples, tuple(validation))


def camera_mapping(pixel_scale=1.):
    return {'matrix': (MATRIX * pixel_scale).tolist(), 'pixel_scale': pixel_scale,
            'origin_us': {'yaw': 1700., 'pitch': 2000.},
            'context': ('profile', 'firmware', 'camera', 90),
            'calibration_revision': 'original-revision', 'fit_error_px': 1.2 * pixel_scale}


@pytest.mark.parametrize('pixel_scale', [1., 2.])
def test_observed_step_advances_map_without_mutating_inputs(pixel_scale):
    mapping = camera_mapping(pixel_scale)
    current = {'yaw': 1700., 'pitch': 2000.}
    target = {'yaw': 1710., 'pitch': 2010.}
    before = np.array([250., 500.]) * pixel_scale
    step = np.array([10., 10.])
    innovation = np.array([2., -1.]) * pixel_scale
    after = before + MATRIX @ step * pixel_scale + innovation
    original = deepcopy((mapping, current, target))
    original_points = (before.copy(), after.copy())

    result = advance_camera_map(mapping, before, after, current, target)

    expected = MATRIX * pixel_scale + .25 * np.outer(innovation, step) / np.dot(step, step)
    np.testing.assert_allclose(result['matrix'], expected)
    assert result['origin_us'] == target
    assert result['step_error_px'] == pytest.approx(np.linalg.norm(innovation))
    assert result['context'] == mapping['context']
    assert result['calibration_revision'] == mapping['calibration_revision']
    assert (mapping, current, target) == original
    np.testing.assert_array_equal(before, original_points[0])
    np.testing.assert_array_equal(after, original_points[1])
    # Returned nested containers must not alias any caller-owned mutable state.
    result['matrix'][0][0] = 999
    result['origin_us']['yaw'] = 999
    assert (mapping, current, target) == original


@pytest.mark.parametrize('failure', ['no_command', 'no_motion', 'opposite', 'divergent', 'nan', 'infinite'])
def test_unverified_step_cannot_advance_calibration_origin(failure):
    mapping = camera_mapping()
    original = deepcopy(mapping)
    current = {'yaw': 1700., 'pitch': 2000.}
    target = {'yaw': 1710., 'pitch': 2010.}
    before = np.array([250., 500.])
    predicted = MATRIX @ np.array([10., 10.])
    observed = predicted.copy()
    if failure == 'no_command':
        target = dict(current)
    elif failure == 'no_motion':
        observed[:] = 0
    elif failure == 'opposite':
        observed = -predicted
    elif failure == 'divergent':
        observed += [20., -30.]
    elif failure == 'nan':
        observed[0] = np.nan
    else:
        observed[1] = np.inf

    assert advance_camera_map(mapping, before, before + observed, current, target) is None
    assert mapping == original


def test_measured_update_that_would_make_an_axis_unobservable_is_rejected():
    mapping = camera_mapping()
    mapping['matrix'] = [[.03, 0.], [0., .5]]
    original = deepcopy(mapping)
    # The observation passes distance, direction and residual checks, but its
    # damped update would put the smallest singular value below .025.
    result = advance_camera_map(mapping, np.array([0., 0.]), np.array([.6, 2.1]),
                                {'yaw': 1700., 'pitch': 2000.}, {'yaw': 1800., 'pitch': 2000.})

    assert result is None
    assert mapping == original


@pytest.mark.parametrize('replace_calibration', [False, True])
def test_follow_publishes_step_update_only_for_same_calibration(tmp_path, monkeypatch, replace_calibration):
    turret, _, _ = mechanism(tmp_path, monkeypatch)
    mapping = camera_mapping()
    mapping['context'] = turret._context()
    turret.calibration = mapping
    next_mapping = {**deepcopy(mapping), 'calibration_revision': 'newer-revision'}
    move = turret._move
    target = {'yaw': 1710., 'pitch': 2010.}
    correction_calls = []

    def correcting(*args):
        correction_calls.append(True)
        if len(correction_calls) > 1:
            raise RuntimeError('Observed exactly one synthetic move')
        return target, False

    def observed_move(target, cancel):
        point = move(target, cancel)
        if replace_calibration:
            turret.calibration = next_mapping
        return point

    monkeypatch.setattr('ohmpath.devices.turret.correction', correcting)
    monkeypatch.setattr(turret, '_move', observed_move)
    with pytest.raises(RuntimeError, match='exactly one synthetic move'):
        turret._follow(turret.job_cancel, recalibrate=True)

    assert mapping['origin_us'] == {'yaw': 1700., 'pitch': 2000.}
    if replace_calibration:
        assert turret.calibration is next_mapping
        assert 'step_error_px' not in turret.calibration
    else:
        assert turret.calibration is not mapping
        assert turret.calibration['origin_us'] == target
        assert turret.calibration['step_error_px'] == pytest.approx(0., abs=1e-8)
