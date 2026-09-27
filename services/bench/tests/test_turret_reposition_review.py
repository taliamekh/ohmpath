"""Reposition review regressions: synthetic images and in-memory outputs only."""
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.devices.turret import Turret
from ohmpath.devices.turret_framing import SceneFraming
from test_turret_framing import frame, texture
from test_turret_reposition import ready, mark
from test_turret_tour import Identifier


def test_framing_status_does_not_hide_lost_geometry_behind_completed_job(tmp_path):
    turret = Turret(tmp_path)
    reference = frame(texture())
    turret.framing_tracker = SceneFraming(reference, {'x': .2, 'y': .2, 'width': .5, 'height': .5})
    turret.framing = {'framing_id': 'reference-framing', 'state': 'completed',
                      'message': 'Marked circuit area centred.'}
    with pytest.raises(ValueError, match='generation'):
        turret.framing_tracker.update(frame(reference['image'], sequence=11, generation='different-camera'))
    result = turret.status()['framing']
    assert result['geometry_current'] is False
    assert result['state'] == 'lost'
    assert 'lost' in result['message']


def test_framing_status_preserves_too_large_failure_instead_of_ready_message(tmp_path):
    turret = Turret(tmp_path)
    image = texture()
    reference = frame(image)
    turret.framing_tracker = SceneFraming(reference, {'x': .17, 'y': .2, 'width': .65, 'height': .5})
    turret.framing = {'framing_id': 'reference-framing', 'state': 'ready',
                      'message': 'Circuit area marked.'}
    matrix = cv2.getRotationMatrix2D((319.5, 239.5), 0, 1.5)
    magnified = cv2.warpAffine(image, matrix, (640, 480))
    with pytest.raises(ValueError, match='too large'):
        turret.framing_tracker.update(frame(magnified, sequence=11))
    result = turret.status()['framing']
    assert result['state'] == 'lost'
    assert result['geometry_state'] == 'too_large'
    assert result['fits_with_margin'] is False
    assert 'too large' in result['message']


def test_start_with_changed_camera_rejects_without_motor_output_and_reports_lost(tmp_path):
    turret = ready(tmp_path)
    try:
        turret.arm(clear=True, laser_disconnected=True, commissioning=False)
        ident = mark(turret)
        before = list(turret.control.motion.driver.outputs)
        turret.video.generation = 'replacement-camera-generation'
        with pytest.raises(ValueError, match='generation'):
            turret.reposition(ident)
        assert turret.control.motion.driver.outputs == before
        assert turret.phase == 'idle'
        assert turret.status()['framing']['state'] == 'lost'
    finally:
        turret.close()


def test_identify_by_framing_uses_current_registered_bounds_after_scene_shift(tmp_path):
    turret = ready(tmp_path)
    turret.identifier = Identifier()
    try:
        initial = {'x': .2, 'y': .2, 'width': .4, 'height': .4}
        ident = mark(turret, initial)
        # Change only synthetic camera geometry. No actuator command is issued.
        turret.control.motion.position = [1560, 1530]
        result = turret.identify_components(framing_id=ident)
        roi = result['component_map']['roi']
        assert roi['x'] == pytest.approx(initial['x'] + 30 / 639, abs=.01)
        assert roi['y'] == pytest.approx(initial['y'] + 12 / 479, abs=.01)
        assert roi['width'] == pytest.approx(initial['width'], abs=.01)
        assert roi['height'] == pytest.approx(initial['height'], abs=.01)
        assert not turret.control.motion.driver.outputs
        assert turret.component_map.source_sequence > 1
    finally:
        turret.close()


def test_identify_rejects_old_framing_id_and_mixed_coordinates_without_starting_model(tmp_path):
    turret = ready(tmp_path)
    turret.identifier = Identifier()
    try:
        ident = mark(turret)
        with pytest.raises(ValueError, match='current circuit area'):
            turret.identify_components(framing_id='old-framing-id')
        with pytest.raises(ValueError, match='either'):
            turret.identify_components(framing_id=ident, roi={'x': .1, 'y': .1, 'width': .5, 'height': .5})
        assert not hasattr(turret.identifier, 'image_id')
        assert turret.framing['framing_id'] == ident
        assert not turret.control.motion.driver.outputs
    finally:
        turret.close()


def test_identify_route_rejects_mixed_framing_and_image_region_payload(tmp_path):
    app = create_app(tmp_path, 'u' * 40, 'm' * 40)
    with TestClient(app) as client:
        response = client.post('/v1/turret/identify-components', headers={'Authorization': 'Bearer ' + 'u' * 40},
                               json={'framing_id': '00000000-0000-0000-0000-000000000001',
                                     'roi': {'x': .1, 'y': .1, 'width': .5, 'height': .5},
                                     'sequence': 1, 'generation': 'synthetic-camera-generation'})
        assert response.status_code == 422
        assert app.state.turret.component_map is None


def test_prepared_scene_survives_arm_home_and_updates_bounds_without_reselection(tmp_path):
    turret = ready(tmp_path)
    try:
        # The chosen upper region stays visible after this synthetic home shift.
        ident = mark(turret, {'x': .15, 'y': .08, 'width': .45, 'height': .3})
        before = turret.status()['framing']
        tracker = turret.framing_tracker
        turret.arm(clear=True, laser_disconnected=True, commissioning=False)
        current_frame = turret._frame()
        tracker.update(current_frame)
        after = turret.status()['framing']
        assert after['framing_id'] == ident
        assert turret.framing_tracker is tracker
        assert after['geometry_current']
        np.testing.assert_allclose(after['bounds']['x'], before['bounds']['x'], atol=.015)
        assert after['bounds']['y'] > before['bounds']['y'] + .35
    finally:
        turret.close()
