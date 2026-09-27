"""The displayed aiming marker must come from the displayed image, without motion."""
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from ohmpath.devices.turret import Turret


def camera(tmp_path, orientation=0):
    turret = Turret(tmp_path)
    turret.orientation = orientation
    image = np.full((480, 640, 3), 60, dtype=np.uint8)
    frame = {'image': image, 'sequence': 1, 'generation': 'preview-camera'}
    turret.video = SimpleNamespace(frame=lambda: frame)
    return turret, frame


def test_released_preview_automatically_marks_actual_offset_and_never_arms(tmp_path):
    turret, frame = camera(tmp_path)
    cv2.circle(frame['image'], (425, 290), 6, (25, 30, 255), -1)
    result = turret.frame()['frame']
    assert result['laser_spot']['x'] == pytest.approx(425/639, abs=.002)
    assert result['laser_spot']['y'] == pytest.approx(290/479, abs=.002)
    assert turret.aim_reference is None
    assert not turret.state.get('armed')
    assert turret.control is None


def test_missing_spot_does_not_fall_back_to_saved_reference_or_centre(tmp_path):
    turret, frame = camera(tmp_path)
    turret.aim_reference = {'generation': frame['generation'], 'orientation': 0,
                            'x': .66, 'y': .60, 'source': 'observed_red_spot'}
    cv2.circle(frame['image'], (425, 290), 6, (25, 30, 255), -1)
    assert turret.frame()['frame']['laser_spot'] is not None
    frame['sequence'] += 1
    frame['image'][:] = 60
    result = turret.frame()['frame']
    assert result['laser_spot'] is None
    assert 'No clear compact red spot' in result['laser_spot_message']
    assert turret.aim_reference['x'] == .66


def test_preview_spot_matches_rotated_image_and_ignores_old_generation_seed(tmp_path):
    turret, frame = camera(tmp_path, orientation=90)
    turret.aim_reference = {'generation': 'old-camera', 'orientation': 90,
                            'x': .99, 'y': .99, 'source': 'observed_red_spot'}
    cv2.circle(frame['image'], (425, 290), 6, (25, 30, 255), -1)
    result = turret.frame()['frame']
    assert (result['width'], result['height']) == (480, 640)
    assert result['laser_spot']['x'] == pytest.approx((479-290)/479, abs=.002)
    assert result['laser_spot']['y'] == pytest.approx(425/639, abs=.002)


def test_ambiguous_preview_has_no_aiming_marker_until_user_selects_spot(tmp_path):
    turret, frame = camera(tmp_path)
    for point in ((220, 180), (420, 290)):
        cv2.circle(frame['image'], point, 6, (25, 30, 255), -1)
    result = turret.frame()['frame']
    assert result['laser_spot'] is None
    assert 'Multiple plausible' in result['laser_spot_message']
    turret.aim_reference = {'generation': frame['generation'], 'orientation': 0,
                            'x': 420/639, 'y': 290/479, 'source': 'observed_red_spot'}
    frame['sequence'] += 1
    assert turret.frame()['frame']['laser_spot']['x'] == pytest.approx(420/639, abs=.002)


def test_observed_beam_continuity_excludes_secondary_reflection_without_old_point_fallback(tmp_path):
    turret, frame = camera(tmp_path)
    cv2.circle(frame['image'], (360, 270), 4, (25, 30, 255), -1)
    turret._observe_spot(frame)
    cv2.circle(frame['image'], (378, 286), 4, (25, 30, 255), -1)
    frame['sequence'] += 1
    assert turret._observe_spot(frame) == pytest.approx((360/639, 270/479), abs=.002)
    assert turret.frame()['frame']['laser_spot']['x'] == pytest.approx(360/639, abs=.002)
    cv2.circle(frame['image'], (360, 270), 6, (60, 60, 60), -1)
    frame['sequence'] += 1
    with pytest.raises(ValueError, match='No clear compact'):
        turret._observe_spot(frame)
    assert turret.frame()['frame']['laser_spot'] is None


def test_preview_tracks_small_current_frame_shift_without_using_it_for_motion(tmp_path):
    turret, frame = camera(tmp_path)
    cv2.circle(frame['image'], (320, 240), 5, (25, 30, 255), -1)
    assert turret.frame()['frame']['laser_spot']['x'] == pytest.approx(320/639, abs=.002)
    frame['sequence'] += 1
    frame['image'][:] = 60
    cv2.circle(frame['image'], (333, 240), 5, (25, 30, 255), -1)
    cv2.circle(frame['image'], (470, 300), 5, (25, 30, 255), -1)
    result = turret.frame()['frame']
    assert result['laser_spot']['x'] == pytest.approx(333/639, abs=.002)
    assert turret.aim_reference is None
    assert not turret.state.get('armed')
    frame['sequence'] += 1
    frame['image'][:] = 60
    cv2.circle(frame['image'], (470, 300), 5, (25, 30, 255), -1)
    assert turret.frame()['frame']['laser_spot'] is None
