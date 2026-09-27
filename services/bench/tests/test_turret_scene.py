"""Deterministic image-only replay: no cameras, network or motor drivers."""
import cv2
import numpy as np
import pytest

from ohmpath.devices.turret_scene import RegisteredScene


ROI = {'x': 0.12, 'y': 0.13, 'width': 0.74, 'height': 0.72}


def texture(width=640, height=480, seed=73):
    rng = np.random.default_rng(seed)
    noise = np.clip(rng.normal(135, 18, (height, width)), 0, 255).astype(np.uint8)
    image = cv2.cvtColor(cv2.GaussianBlur(noise, (3, 3), 0), cv2.COLOR_GRAY2BGR)
    for index in range(300):
        x, y = int(rng.integers(10, width - 10)), int(rng.integers(10, height - 10))
        color = tuple(int(value) for value in rng.integers(20, 240, 3))
        if index % 3:
            cv2.circle(image, (x, y), int(rng.integers(2, 8)), color, -1)
        else:
            cv2.putText(image, f'{index:X}', (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1)
    return image


def frame(image, sequence=10, generation='camera-one'):
    return {'image': image, 'generation': generation, 'sequence': sequence}


def project(matrix, x, y, width, height):
    point = matrix @ [x * (width - 1), y * (height - 1), 1.]
    return point[:2] / point[2]


def transform(width, height, kind):
    if kind == 'translation':
        return np.array([[1., 0, 19.], [0, 1., -12.], [0, 0, 1.]])
    if kind == 'rotation':
        return np.vstack((cv2.getRotationMatrix2D(((width - 1) / 2, (height - 1) / 2), 12, 0.97), [0, 0, 1]))
    corners = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    return cv2.getPerspectiveTransform(corners, corners + np.float32([[18, 14], [-17, 8], [-8, -23], [22, -5]]))


@pytest.mark.parametrize('size', [(640, 480), (1280, 720), (720, 1280)])
@pytest.mark.parametrize('kind', ['translation', 'rotation', 'projective'])
def test_registered_points_follow_moderate_plane_change_in_full_image_pixels(size, kind):
    width, height = size
    reference = texture(width, height)
    # Component-like targets carry visible local detail; arbitrary blank board
    # locations must not pass the separate appearance-verification requirement.
    rng = np.random.default_rng(5)
    for x, y in ((0.32, 0.39), (0.59, 0.61)):
        center_x, center_y = round(x * (width - 1)), round(y * (height - 1))
        body = cv2.resize(rng.integers(20, 240, (8, 8, 3), dtype=np.uint8), (48, 48),
                          interpolation=cv2.INTER_NEAREST)
        reference[center_y - 24:center_y + 24, center_x - 24:center_x + 24] = body
    scene = RegisteredScene(frame(reference), ROI)
    matrix = transform(width, height, kind)
    scene.update(frame(cv2.warpPerspective(reference, matrix, size), sequence=11))
    for x, y in ((0.32, 0.39), (0.59, 0.61)):
        np.testing.assert_allclose(scene.resolve(x, y), project(matrix, x, y, width, height), atol=2.5)
        np.testing.assert_allclose(scene.verify_point(x, y), scene.resolve(x, y))
    summary = scene.summary()
    assert summary['state'] == 'registered'
    assert summary['inliers'] >= 16
    assert summary['sequence'] == 11
    assert summary['reprojection_rms_px'] < 3


def test_reference_identity_and_same_sequence_cache_do_not_repeat_feature_work():
    reference = texture()
    scene = RegisteredScene(frame(reference), ROI)
    expected = [0.4 * 639, 0.6 * 479]
    np.testing.assert_allclose(scene.resolve(0.4, 0.6), expected)
    scene.update(frame(reference.copy()))
    np.testing.assert_allclose(scene.resolve(0.4, 0.6), expected)
    result = scene.resolve(0.4, 0.6)
    result[:] = 0
    np.testing.assert_allclose(scene.resolve(0.4, 0.6), expected)
    scene.summary()['roi']['x'] = 0.9
    assert scene.summary()['roi'] == ROI


@pytest.mark.parametrize('invalid', [
    {'x': -0.1, 'y': 0.1, 'width': 0.5, 'height': 0.5},
    {'x': 0.8, 'y': 0.1, 'width': 0.5, 'height': 0.5},
    {'x': 0.1, 'y': 0.8, 'width': 0.5, 'height': 0.5},
    {'x': 0.1, 'y': 0.1, 'width': 0, 'height': 0.5},
    {'x': float('nan'), 'y': 0.1, 'width': 0.5, 'height': 0.5},
    {'x': True, 'y': 0.1, 'width': 0.5, 'height': 0.5},
    {'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': float('inf')},
    {'x': 0.1, 'y': 0.1, 'width': 0.01, 'height': 0.5},
    {'x': 0.1, 'y': 0.1, 'width': 0.5},
])
def test_invalid_or_too_small_reference_roi_rejected(invalid):
    with pytest.raises(ValueError):
        RegisteredScene(frame(texture()), invalid)


@pytest.mark.parametrize('point', [(-0.1, 0.5), (0.5, 1.0), (0.9, 0.5), (float('nan'), 0.5), (True, 0.5)])
def test_reference_point_outside_roi_or_invalid_is_rejected(point):
    scene = RegisteredScene(frame(texture()), ROI)
    with pytest.raises(ValueError):
        scene.resolve(*point)
    assert scene.summary()['state'] == 'registered'


@pytest.mark.parametrize('change', ['blank', 'unrelated', 'old_sequence', 'generation', 'size'])
def test_lost_or_stale_scene_is_latched_and_never_silently_reacquired(change):
    reference = texture()
    scene = RegisteredScene(frame(reference), ROI)
    if change == 'blank':
        invalid = frame(np.zeros_like(reference), 11)
    elif change == 'unrelated':
        invalid = frame(texture(seed=99), 11)
    elif change == 'old_sequence':
        invalid = frame(reference, 9)
    elif change == 'generation':
        invalid = frame(reference, 11, generation='replacement-camera')
    else:
        invalid = frame(cv2.resize(reference, (720, 480)), 11)
    with pytest.raises(ValueError):
        scene.update(invalid)
    with pytest.raises(ValueError, match='lost'):
        scene.resolve(0.4, 0.4)
    with pytest.raises(ValueError, match='lost'):
        scene.update(frame(reference, 12))
    assert scene.summary()['state'] == 'lost'


def test_same_sequence_still_rejects_replaced_camera():
    scene = RegisteredScene(frame(texture()), ROI)
    with pytest.raises(ValueError, match='generation'):
        scene.update(frame(texture(), generation='new-camera'))


def test_blank_or_clustered_reference_cannot_register_a_plane():
    with pytest.raises(ValueError, match='few distinctive'):
        RegisteredScene(frame(np.zeros((480, 640, 3), np.uint8)), ROI)
    clustered = np.zeros((480, 640, 3), np.uint8)
    clustered[200:280, 280:360] = texture(80, 80)
    with pytest.raises(ValueError, match='clustered'):
        RegisteredScene(frame(clustered), ROI)


def test_duplicate_circuit_patches_are_not_accepted_as_unique_scene():
    patch = texture(240, 240)
    reference = np.full((480, 640, 3), 120, np.uint8)
    reference[120:360, 200:440] = patch
    scene = RegisteredScene(frame(reference), {'x': 200 / 639, 'y': 120 / 479,
                                               'width': 239 / 639, 'height': 239 / 479})
    ambiguous = np.full_like(reference, 120)
    ambiguous[120:360, 30:270] = patch
    ambiguous[120:360, 370:610] = patch
    with pytest.raises(ValueError):
        scene.update(frame(ambiguous, 11))


def test_target_leaving_current_image_is_rejected_even_when_board_remains_registered():
    reference = texture()
    scene = RegisteredScene(frame(reference), {'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8})
    matrix = np.array([[1., 0, 100], [0, 1., 0], [0, 0, 1.]])
    scene.update(frame(cv2.warpPerspective(reference, matrix, (640, 480)), 11))
    scene.resolve(0.4, 0.5)
    with pytest.raises(ValueError, match='outside the current'):
        scene.resolve(0.89, 0.5)


def test_removed_component_fails_local_verification_with_board_still_registered():
    reference = texture()
    scene = RegisteredScene(frame(reference), ROI)
    changed = reference.copy()
    changed[205:275, 285:355] = 135
    scene.update(frame(changed, 11))
    scene.resolve(0.5, 0.5)
    with pytest.raises(ValueError, match='texture|appearance'):
        scene.verify_point(0.5, 0.5)
    assert scene.summary()['state'] == 'registered'


def test_moved_component_fails_local_verification_with_board_still_registered():
    reference = texture()
    # A distinctive body dominates the target neighbourhood, unlike board texture.
    rng = np.random.default_rng(404)
    body = rng.integers(0, 256, (64, 64, 3), dtype=np.uint8)
    reference[208:272, 288:352] = body
    scene = RegisteredScene(frame(reference), ROI)
    changed = reference.copy()
    changed[208:272, 288:352] = 135
    changed[280:344, 365:429] = body
    scene.update(frame(changed, 11))
    with pytest.raises(ValueError, match='texture|appearance'):
        scene.verify_point(0.5, 0.5)


def test_textured_occluder_is_rejected_even_without_a_flat_patch():
    reference = texture()
    rng = np.random.default_rng(808)
    reference[208:272, 288:352] = cv2.resize(rng.integers(0, 256, (8, 8, 3), np.uint8),
                                           (64, 64), interpolation=cv2.INTER_NEAREST)
    scene = RegisteredScene(frame(reference), ROI)
    changed = reference.copy()
    changed[208:272, 288:352] = cv2.resize(rng.integers(0, 256, (8, 8, 3), np.uint8),
                                         (64, 64), interpolation=cv2.INTER_NEAREST)
    scene.update(frame(changed, 11))
    with pytest.raises(ValueError, match='appearance'):
        scene.verify_point(0.5, 0.5)


def test_flat_target_is_not_verified_from_distant_scene_texture():
    reference = texture()
    reference[200:280, 280:360] = 135
    scene = RegisteredScene(frame(reference), ROI)
    with pytest.raises(ValueError, match='texture'):
        scene.verify_point(0.5, 0.5)


def test_large_shear_is_rejected():
    reference = texture()
    scene = RegisteredScene(frame(reference), ROI)
    matrix = np.array([[1., 0.7, -100], [0, 1., 0], [0, 0, 1.]])
    with pytest.raises(ValueError):
        scene.update(frame(cv2.warpPerspective(reference, matrix, (640, 480)), 11))


@pytest.mark.parametrize('scale', [0.3, 2.5])
def test_excessive_plane_scale_is_rejected(scale):
    reference = texture()
    scene = RegisteredScene(frame(reference), ROI)
    matrix = np.vstack((cv2.getRotationMatrix2D((319.5, 239.5), 0, scale), [0, 0, 1]))
    with pytest.raises(ValueError):
        scene.update(frame(cv2.warpPerspective(reference, matrix, (640, 480)), 11))
