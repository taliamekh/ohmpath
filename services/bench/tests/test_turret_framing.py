"""Synthetic scene-framing replay without cameras, models or hardware output."""
import cv2
import numpy as np
import pytest

from ohmpath.devices.turret_framing import SceneFraming
from ohmpath.devices.turret_scene import RegisteredScene


ROI = {'x': 0.15, 'y': 0.18, 'width': 0.55, 'height': 0.56}


def texture(width=640, height=480):
    rng = np.random.default_rng(424)
    pixels = rng.integers(20, 235, (height // 4, width // 4, 3), dtype=np.uint8)
    return cv2.resize(pixels, (width, height), interpolation=cv2.INTER_NEAREST)


def frame(pixels, sequence=10, generation='framing-camera'):
    return {'image': pixels, 'sequence': sequence, 'generation': generation}


def projected_corners(matrix, roi, size):
    width, height = size
    x, y, dx, dy = (roi[key] for key in ('x', 'y', 'width', 'height'))
    corners = np.array([[x, y], [x + dx, y], [x + dx, y + dy], [x, y + dy]])
    homogeneous = np.column_stack((corners * [width - 1, height - 1], np.ones(4))) @ matrix.T
    return homogeneous[:, :2] / homogeneous[:, 2, None]


def test_reference_geometry_and_returned_summary_have_independent_copies():
    reference = frame(texture())
    framing = SceneFraming(reference, ROI)
    expected = np.array([0.425 * 639, 0.46 * 479])
    point = framing.update(reference)
    np.testing.assert_allclose(point, expected)
    summary = framing.summary()
    assert summary['bounds'] == pytest.approx(ROI)
    assert summary['centre'] == pytest.approx({'x': 0.425, 'y': 0.46})
    assert summary['selected_region_visible'] and summary['fits_with_margin']
    assert summary['geometry_current']
    assert summary['full_circuit_coverage_verified'] is False
    assert summary['source_touched_edge'] is False
    point[:] = 0
    summary['bounds']['x'] = 0.9
    summary['roi']['x'] = 0.9
    np.testing.assert_allclose(framing.update(reference), expected)
    assert framing.summary()['roi'] == ROI
    assert framing.summary()['bounds'] == pytest.approx(ROI)


@pytest.mark.parametrize('size', [(640, 480), (720, 1280)])
@pytest.mark.parametrize('kind', ['translation', 'perspective'])
def test_projected_region_tracks_current_bounding_centre_and_bounds(size, kind):
    width, height = size
    pixels = texture(width, height)
    framing = SceneFraming(frame(pixels), ROI)
    if kind == 'translation':
        matrix = np.array([[1., 0, 27], [0, 1., -19], [0, 0, 1.]])
    else:
        source = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
        matrix = cv2.getPerspectiveTransform(source, source + np.float32([[17, 20], [-15, 7], [-9, -20], [18, -7]]))
    corners = projected_corners(matrix, ROI, size)
    lower, upper = corners.min(axis=0), corners.max(axis=0)
    point = framing.update(frame(cv2.warpPerspective(pixels, matrix, size), 11))
    np.testing.assert_allclose(point, (lower + upper) / 2, atol=2)
    summary = framing.summary()
    dims = np.array([width - 1, height - 1])
    expected_bounds = np.r_[lower / dims, (upper - lower) / dims]
    np.testing.assert_allclose([summary['bounds'][key] for key in ('x', 'y', 'width', 'height')],
                               expected_bounds, atol=2 / min(dims))
    assert summary['sequence'] == 11
    assert summary['reference_sequence'] == 10


def test_flat_region_centre_does_not_require_a_trackable_point_patch():
    pixels = texture()
    center = np.array([0.425 * 639, 0.46 * 479]).round().astype(int)
    pixels[center[1] - 55:center[1] + 55, center[0] - 55:center[0] + 55] = 128
    framing = SceneFraming(frame(pixels), ROI)
    with pytest.raises(ValueError, match='texture'):
        framing.scene.verify_point(0.425, 0.46)
    matrix = np.float32([[1, 0, 24], [0, 1, -18]])
    result = framing.update(frame(cv2.warpAffine(pixels, matrix, (640, 480)), 11))
    np.testing.assert_allclose(result, [0.425 * 639 + 24, 0.46 * 479 - 18], atol=2)
    assert framing.summary()['state'] == 'registered'


def test_partly_clipped_selection_can_be_framed_without_authorizing_off_image_targets():
    pixels = texture()
    framing = SceneFraming(frame(pixels), ROI)
    matrix = np.float32([[1, 0, -130], [0, 1, 0]])
    point = framing.update(frame(cv2.warpAffine(pixels, matrix, (640, 480)), 11))
    np.testing.assert_allclose(point, [0.425 * 639 - 130, 0.46 * 479], atol=2)
    summary = framing.summary()
    assert summary['bounds']['x'] < 0
    assert summary['selected_region_visible'] is False
    assert summary['fits_with_margin'] and summary['geometry_current']
    assert summary['source_touched_edge'] is False
    with pytest.raises(ValueError, match='outside the current'):
        framing.scene.resolve(ROI['x'], ROI['y'])
    corners = framing.scene.project_region()
    assert np.min(corners[:, 0]) < 0
    corners[:] = 0
    assert np.max(framing.scene.project_region()) > 100


def test_source_edge_flag_does_not_claim_hidden_circuit_extent():
    pixels = texture()
    roi = {'x': 0., 'y': 0.15, 'width': 0.5, 'height': 0.6}
    framing = SceneFraming(frame(pixels), roi)
    summary = framing.summary()
    assert summary['source_touched_edge']
    assert summary['selected_region_visible']
    assert summary['full_circuit_coverage_verified'] is False
    assert 'unknown' in summary['message']
    shifted = cv2.warpAffine(pixels, np.float32([[1, 0, 35], [0, 1, 0]]), (640, 480))
    framing.update(frame(shifted, 11))
    assert framing.summary()['source_touched_edge']


def test_initial_oversized_selection_reports_specific_fit_failure():
    roi = {'x': 0.01, 'y': 0.1, 'width': 0.98, 'height': 0.8}
    with pytest.raises(ValueError, match='too large.*5% margin'):
        SceneFraming(frame(texture()), roi)


def test_later_oversized_region_has_diagnostic_summary_and_no_new_target():
    pixels = texture()
    roi = {'x': 0.15, 'y': 0.15, 'width': 0.7, 'height': 0.7}
    framing = SceneFraming(frame(pixels), roi)
    matrix = cv2.getRotationMatrix2D((319.5, 239.5), 0, 1.4)
    current = frame(cv2.warpAffine(pixels, matrix, (640, 480)), 11)
    with pytest.raises(ValueError, match='too large'):
        framing.update(current)
    summary = framing.summary()
    assert summary['state'] == 'too_large'
    assert not summary['fits_with_margin']
    assert summary['geometry_current']
    assert summary['bounds']['width'] > 0.9
    assert summary['centre'] is not None


def test_factory_shares_existing_full_frame_reference_without_recapture(monkeypatch):
    pixels = texture()
    whole = {'x': 0., 'y': 0., 'width': 1., 'height': 1.}
    scene = RegisteredScene(frame(pixels), whole)

    def no_new_reference(*args, **kwargs):
        raise AssertionError('Sharing must not create a new reference scene.')

    monkeypatch.setattr(RegisteredScene, '__init__', no_new_reference)
    framing = SceneFraming.from_scene(scene, margin=0.0)
    assert framing.scene is scene
    np.testing.assert_allclose(framing.update(frame(pixels)), [319.5, 239.5])
    assert framing.summary()['fits_with_margin']
    assert framing.summary()['source_touched_edge']
    assert framing.summary()['margin_fraction'] == 0
    # Another owner can update the shared map; summary must reflect its geometry.
    shifted = cv2.warpAffine(pixels, np.float32([[1, 0, 7], [0, 1, 0]]), (640, 480))
    scene.update(frame(shifted, 11))
    summary = framing.summary()
    assert summary['sequence'] == 11 and summary['fits_with_margin']
    assert summary['centre']['x'] == pytest.approx((319.5 + 7) / 639, abs=2 / 639)
    assert summary['selected_region_visible'] is False


def test_zero_margin_constructor_accepts_whole_visible_selection():
    framing = SceneFraming(frame(texture()), {'x': 0., 'y': 0., 'width': 1., 'height': 1.}, margin=0.0)
    assert framing.summary()['fits_with_margin']


@pytest.mark.parametrize('failure', ['sequence', 'generation', 'blank', 'mostly_outside'])
def test_lost_scene_stays_lost_and_summary_retains_explicitly_stale_geometry(failure):
    pixels = texture()
    framing = SceneFraming(frame(pixels), ROI)
    previous = framing.summary()
    if failure == 'sequence':
        bad = frame(pixels, 9)
    elif failure == 'generation':
        bad = frame(pixels, 11, generation='new-camera')
    elif failure == 'blank':
        bad = frame(np.full_like(pixels, 128), 11)
    else:
        bad = frame(cv2.warpAffine(pixels, np.float32([[1, 0, -350], [0, 1, 0]]), (640, 480)), 11)
    with pytest.raises(ValueError):
        framing.update(bad)
    summary = framing.summary()
    assert summary['state'] == 'lost'
    assert not summary['geometry_current'] and not summary['selected_region_visible']
    assert not summary['fits_with_margin']
    assert summary['centre'] == previous['centre']
    assert summary['bounds'] == previous['bounds']
    with pytest.raises(ValueError, match='lost'):
        framing.scene.project_region()
    with pytest.raises(ValueError, match='lost'):
        framing.update(frame(pixels, 12))


def test_shared_scene_loss_is_reflected_without_calling_framing_update():
    pixels = texture()
    scene = RegisteredScene(frame(pixels), ROI)
    framing = SceneFraming.from_scene(scene)
    with pytest.raises(ValueError):
        scene.update(frame(np.zeros_like(pixels), 11))
    assert framing.summary()['state'] == 'lost'
    assert not framing.summary()['geometry_current']


@pytest.mark.parametrize('margin', [-0.01, 0.5, True, float('nan'), float('inf'), '0.05'])
def test_invalid_margin_is_not_a_framing_configuration(margin):
    with pytest.raises(ValueError, match='margin'):
        SceneFraming(frame(texture()), ROI, margin=margin)


@pytest.mark.parametrize('roi', [
    {'x': -0.1, 'y': 0.1, 'width': 0.5, 'height': 0.5},
    {'x': 0.1, 'y': 0.1, 'width': 0.05, 'height': 0.5},
])
def test_region_must_be_visible_at_selection_and_at_least_64_pixels(roi):
    with pytest.raises(ValueError):
        SceneFraming(frame(texture()), roi)
