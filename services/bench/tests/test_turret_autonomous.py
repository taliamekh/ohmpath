"""Real orchestration with synthetic images and in-memory actuators, never hardware."""
import threading
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.devices.turret import Turret
from test_turret_tour import Control, Video, Identifier


class DiagnosticIdentifier(Identifier):
    def start_diagnosis(self, context, image_id, jpeg, question):
        self.question = question
        return self.start(context, image_id, jpeg)

    def status(self, turn_id):
        result = super().status(turn_id)
        result['answer'].update(explanation='The resistor connection is uncertain.',
                                next_steps=['Inspect the resistor lead.'], limitations=['No voltage was measured.'])
        return result


class SpotVideo(Video):
    def __init__(self, control):
        super().__init__(control)
        gray = cv2.cvtColor(self.reference, cv2.COLOR_BGR2GRAY)
        self.reference = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    def frame(self):
        frame = super().frame()
        if frame:
            # Beam is camera-mounted, unlike the translating board texture.
            cv2.circle(frame['image'], (320, 290), 4, (20, 20, 255), -1)
        return frame


def ready(tmp_path, monkeypatch):
    turret = Turret(tmp_path, identifier=DiagnosticIdentifier())
    turret.control = Control()
    turret.video = SpotVideo(turret.control)
    turret.state = turret.control.motion.status()
    turret.keepalive()
    monkeypatch.setattr('ohmpath.devices.turret.find_circuit_region', lambda image: None)

    def settle(cancel, timeout=2.5):
        with turret.lock:
            turret._check_session(cancel)
            motion = turret.control.motion
            motion.position = list(motion.target)
            motion.driver.move(motion.position)
            turret.state = motion.status()
            frame = turret._frame()
            if turret.tracker:
                turret.point = turret.tracker.update(frame)
                turret.point_sequence = frame['sequence']
            return turret.point.copy() if turret.point is not None else frame

    monkeypatch.setattr(turret, '_settle', settle)
    monkeypatch.setattr(turret, '_refresh_guidance_camera', lambda cancel: turret._check_session(cancel))
    monkeypatch.setattr(turret, '_wait_view', lambda cancel, timeout=4: (settle(cancel), turret._frame())[1])
    return turret


def finish(turret, timeout=20):
    deadline = time.monotonic() + timeout
    while turret.job_thread.is_alive() and time.monotonic() < deadline:
        with turret.lock:
            turret.presence = time.monotonic()
            turret._request('heartbeat')
            frame = turret._frame()
            if turret.component_map:
                turret.component_map.update(frame, turret._context())
            if turret.tracker:
                turret.point = turret.tracker.update(frame)
                turret.point_sequence = frame['sequence']
        time.sleep(.025)
    turret.job_thread.join(.5)
    assert not turret.job_thread.is_alive(), turret.status()


def test_one_start_arms_diagnoses_centres_and_points_using_observed_spot(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    assert not turret.state['armed']
    result = turret.start_guidance('Why is my resistor circuit not working?')
    assert result['armed'] and result['guidance']['state'] == 'running'
    finish(turret)
    result = turret.status()
    assert result['guidance']['state'] == 'completed', result['guidance']
    assert len(result['guidance']['visited']) == 2
    assert result['guidance']['answer']['next_steps'] == ['Inspect the resistor lead.']
    assert result['component_map']['evidence_kind'] == 'visual_diagnosis_candidates'
    assert result['aim_reference']['source'] == 'observed_red_spot'
    frame = turret._frame()
    target = turret.tracker.update(frame)
    spot = np.array([result['aim_reference']['x']*639, result['aim_reference']['y']*479])
    assert np.linalg.norm(target-spot) <= 6
    assert 'move' in turret.control.requests
    assert turret.identifier.question == 'Why is my resistor circuit not working?'
    for yaw, pitch in turret.control.motion.driver.outputs:
        assert turret.profile['yaw']['min'] <= yaw <= turret.profile['yaw']['max']
        assert turret.profile['pitch']['min'] <= pitch <= turret.profile['pitch']['max']
    turret.close()


def test_guidance_observes_beam_before_reflections_appear_in_centred_view(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    centre = turret._centre_region
    original_frame = turret.video.frame

    def centre_with_reflection(cancel, frame, roi):
        assert turret.aim_reference['source'] == 'observed_red_spot'

        def reflected_frame():
            result = original_frame()
            cv2.circle(result['image'], (338, 304), 4, (20, 20, 255), -1)
            return result

        monkeypatch.setattr(turret.video, 'frame', reflected_frame)
        return centre(cancel, frame, roi)

    monkeypatch.setattr(turret, '_centre_region', centre_with_reflection)
    turret.start_guidance('Show the test areas.')
    finish(turret)
    assert turret.guidance['state'] == 'completed', turret.guidance
    assert turret.aim_reference['x'] == pytest.approx(320/639, abs=.002)
    turret.close()


def test_stop_while_reasoning_cancels_request_and_prevents_late_motion(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    entered = threading.Event()
    def running(turn):
        entered.set()
        return {'status':'running'}
    monkeypatch.setattr(turret.identifier, 'status', running)
    turret.start_guidance('Inspect this circuit.')
    assert entered.wait(2)
    before = list(turret.control.motion.driver.outputs)
    turret.stop_follow()
    turret.job_thread.join(2)
    assert not turret.job_thread.is_alive()
    assert turret.identifier.cancelled
    assert turret.control.motion.driver.outputs == before
    assert turret.guidance['state'] == 'stopped'
    turret.close()


def test_stationary_diagnosis_keeps_valid_framing_calibration(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    monkeypatch.setattr('ohmpath.devices.turret.find_circuit_region',
                        lambda image: {'x': .2, 'y': .2, 'width': .6, 'height': .6})
    calibrations = []
    calibrate = turret._calibrate
    def counted(cancel):
        calibrations.append(turret.phase)
        calibrate(cancel)
    monkeypatch.setattr(turret, '_calibrate', counted)
    turret.start_guidance('Show the circuit checks.')
    finish(turret)
    assert turret.guidance['state'] == 'completed', turret.guidance
    assert len(calibrations) == 1
    turret.close()


def test_guidance_rejects_stale_camera_before_arm(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.video.closed = True
    with pytest.raises(ValueError, match='Connect the camera'):
        turret.start_guidance('Find the test areas.')
    assert not turret.control.motion.driver.outputs
    turret.close()


def test_survey_positions_and_every_step_use_saved_limits(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.arm(laser_disconnected=False)
    cancel = turret.job_cancel
    positions = turret._search_positions()
    assert len(positions) == 9
    for target in positions:
        turret.keepalive()
        turret._survey_move(target, cancel)
    for previous, current in zip(turret.control.motion.driver.outputs, turret.control.motion.driver.outputs[1:]):
        assert max(abs(a-b) for a,b in zip(previous,current)) <= 80.001
    for output in turret.control.motion.driver.outputs:
        for axis, value in zip(('yaw','pitch'), output):
            assert turret.profile[axis]['min'] <= value <= turret.profile[axis]['max']
    turret.close()


def test_pointing_refuses_missing_beam_without_inventing_an_offset(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.video = Video(turret.control)
    # Uniform neutral frame has no red candidate; avoids random red pixels.
    frame = turret._frame()
    frame['image'][:] = 90
    with pytest.raises(ValueError, match='No clear compact red spot'):
        turret._observe_spot(frame)
    assert turret.aim_reference is None
    turret.close()


def test_new_routes_reject_model_scope_and_raw_angles(tmp_path):
    app = create_app(tmp_path, 'u'*40, 'm'*40)
    with TestClient(app) as client:
        for path, body in [('guide', {'question':'Inspect the circuit'}),
                           ('point-component', {'map_id':'1'*36, 'component_id':'2'*36})]:
            assert client.post('/v1/turret/'+path, json=body).status_code == 401
            assert client.post('/v1/turret/'+path, json=body, headers={'Authorization':'Bearer '+'m'*40}).status_code == 403
        client.headers['Authorization'] = 'Bearer '+'u'*40
        assert client.post('/v1/turret/guide', json={'question':'Inspect', 'yaw':1550}).status_code == 422
        assert client.post('/v1/turret/point-component', json={'map_id':'1'*36, 'component_id':'2'*36, 'x':.5}).status_code == 422
        assert not app.state.turret.state.get('armed')


def test_calibration_uses_available_side_at_saved_endpoint(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.arm()
    turret.tracker = type('LinearTracker', (), {'update':lambda self,frame:np.array(turret.control.motion.position)/2})()
    turret.control.motion.position = [turret.profile['yaw']['min'],turret.profile['pitch']['max']]
    turret.control.motion.target = list(turret.control.motion.position)
    turret.state = turret.control.motion.status()
    turret.point = turret.tracker.update(turret._frame())
    turret._calibrate(turret.job_cancel)
    assert turret._calibration_valid()
    for output in turret.control.motion.driver.outputs:
        for axis, value in zip(('yaw','pitch'), output):
            assert turret.profile[axis]['min'] <= value <= turret.profile[axis]['max']
    turret.close()
