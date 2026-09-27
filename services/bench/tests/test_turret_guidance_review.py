"""Independent guidance regressions with in-memory state and synthetic frames."""
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.devices.turret import Turret


def ready(tmp_path, monkeypatch):
    turret = Turret(tmp_path)
    frame = {'image': np.zeros((480, 640, 3), dtype=np.uint8),
             'sequence': 10, 'generation': 'synthetic-camera'}
    monkeypatch.setattr(turret, '_frame', lambda: frame)
    turret.video = SimpleNamespace(generation='synthetic-camera')
    turret.state = {'armed': True, 'moving': False, 'driving': False, 'commissioning': False,
                    'commanded_us': {'yaw': 1500, 'pitch': 1500},
                    'target_us': {'yaw': 1500, 'pitch': 1500}}
    turret.presence = time.monotonic()
    turret.point = np.array([100., 100.])
    turret.point_sequence = 9
    turret.calibration = {'context': turret._context(), 'matrix': [[1, 0], [0, 1]],
                          'origin_us': {'yaw': 1500, 'pitch': 1500}}
    turret.guidance = {'state': 'running', 'message': 'Current job', 'stage': 'pointing',
                       'question': 'Check the circuit', 'visited': [], 'index': 0, 'total': 1}
    return turret, frame


def test_spot_and_target_correction_use_the_same_current_frame(tmp_path, monkeypatch):
    turret, frame = ready(tmp_path, monkeypatch)
    updates = []
    expected = np.array([220., 180.])

    def track(current):
        assert current is frame
        updates.append(current['sequence'])
        return expected.copy()

    def observe(current):
        assert current is frame
        assert updates == [10]
        assert turret.point_sequence == current['sequence']
        return .5, .5

    def corrected(mapping, point, size, current, profile, reference):
        np.testing.assert_array_equal(point, expected)
        assert reference == (.5, .5)
        raise RuntimeError('Review inspected correction before any output')

    turret.tracker = SimpleNamespace(update=track)
    monkeypatch.setattr(turret, '_observe_spot', observe)
    monkeypatch.setattr('ohmpath.devices.turret.correction', corrected)
    with pytest.raises(RuntimeError, match='Review inspected'):
        turret._follow(turret.job_cancel, observed_spot=True)


def test_guidance_refreshes_candidate_geometry_before_reframing_new_capture(tmp_path, monkeypatch):
    turret, frame = ready(tmp_path, monkeypatch)
    geometry_sequence = [9]
    expected_roi = {'x': .25, 'y': .2, 'width': .4, 'height': .4}

    def update(current, context):
        assert current is frame and context == turret._context()
        geometry_sequence[0] = current['sequence']

    def framing_region():
        assert geometry_sequence[0] == frame['sequence']
        return expected_roi

    candidate = SimpleNamespace(phase='ready', components=[{'id': 'diagnostic-target'}],
                                update=update, framing_region=framing_region,
                                reanchor=lambda current, context, roi: update(current, context))

    def diagnose(cancel, question, roi):
        turret.component_map = candidate
        return candidate

    def centre(cancel, current, roi):
        assert current is frame and roi == expected_roi
        raise RuntimeError('Review inspected reframing before any output')

    monkeypatch.setattr(turret, '_wait_view', lambda cancel: frame)
    monkeypatch.setattr(turret, '_refresh_guidance_camera', lambda cancel: None)
    monkeypatch.setattr(turret, '_diagnose_view', diagnose)
    monkeypatch.setattr(turret, '_centre_region', centre)
    monkeypatch.setattr('ohmpath.devices.turret.find_circuit_region', lambda image: None)
    with pytest.raises(RuntimeError, match='Review inspected'):
        turret._guide(turret.job_cancel, 'Check the circuit')


def test_stop_prevents_late_survey_move_or_guidance_progress(tmp_path, monkeypatch):
    turret, _ = ready(tmp_path, monkeypatch)
    obsolete = turret.job_cancel
    calls = []
    monkeypatch.setattr(turret, '_request', lambda op, body=None: calls.append((op, body)))
    monkeypatch.setattr(turret, 'status', lambda: {})
    turret.stop_follow()
    message = turret.message
    with pytest.raises(ValueError, match='cancelled'):
        turret._survey_move({'yaw': 1550, 'pitch': 1550}, obsolete)
    with pytest.raises(ValueError, match='cancelled'):
        turret._guide_stage(obsolete, 'completed', 'A late job must not publish this')
    assert calls == [('hold', None)]
    assert turret.message == message
    assert turret.guidance['state'] == 'stopped'


def test_guidance_api_requires_user_and_rejects_actuator_parameters(tmp_path):
    app = create_app(tmp_path, 'u' * 40, 'm' * 40)
    with TestClient(app) as client:
        for endpoint, body in (
            ('guide', {'question': 'Inspect this circuit'}),
            ('point-component', {'map_id': '00000000-0000-0000-0000-000000000001',
                                 'component_id': '00000000-0000-0000-0000-000000000002'}),
        ):
            assert client.post('/v1/turret/' + endpoint, json=body).status_code == 401
            assert client.post('/v1/turret/' + endpoint, json=body,
                               headers={'Authorization': 'Bearer ' + 'm' * 40}).status_code == 403
            assert client.post('/v1/turret/' + endpoint, json={**body, 'yaw': 2000},
                               headers={'Authorization': 'Bearer ' + 'u' * 40}).status_code == 422
        assert app.state.turret.control is None


def settling_frames(tmp_path, monkeypatch, positions):
    """Synthetic fresh observations with an advancing clock and active heartbeat."""
    turret, frame = ready(tmp_path, monkeypatch)
    clock = [time.monotonic()]
    samples = []

    def capture():
        frame['sequence'] += 1
        turret.presence = clock[0]
        return frame

    def track(current):
        point = np.array([float(positions(len(samples))), 180.])
        samples.append(point.copy())
        return point

    def wait(seconds):
        clock[0] += seconds

    monkeypatch.setattr('ohmpath.devices.turret.time', SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(turret, '_frame', capture)
    monkeypatch.setattr(turret.job_cancel, 'wait', wait)
    turret.tracker = SimpleNamespace(update=track)
    return turret, samples


def test_settle_accepts_stability_after_initial_overshoot(tmp_path, monkeypatch):
    positions = [100, 120, 150, 170, 140, 110, 100, 101, 100, 99]
    turret, samples = settling_frames(
        tmp_path, monkeypatch, lambda index: positions[min(index, len(positions) - 1)])

    settled = turret._settle(turret.job_cancel, timeout=1.1)

    assert len(samples) == len(positions)
    np.testing.assert_allclose(settled, [100, 180])
    assert turret.control is None


def test_settle_rejects_continual_drift_at_existing_deadline(tmp_path, monkeypatch):
    turret, samples = settling_frames(tmp_path, monkeypatch, lambda index: 100 + index * 12)

    with pytest.raises(ValueError, match='selected feature did not settle'):
        turret._settle(turret.job_cancel, timeout=1.1)

    assert len(samples) >= 10
    assert turret.control is None


def refocusing_camera(tmp_path, monkeypatch):
    turret, frame = ready(tmp_path, monkeypatch)
    calls = []

    class SyntheticVideo:
        def __init__(self, generation):
            self.generation = generation
            self.pairing = {'synthetic': True}
            self.error = None
            self.started = False
            self.closed = False

        def start(self):
            self.started = True

        def frame(self):
            return frame

        def close(self):
            self.closed = True

    old = SyntheticVideo('old-camera')
    replacement = SyntheticVideo('refocused-camera')
    turret.video = old
    monkeypatch.setattr('ohmpath.devices.turret.VideoLink', lambda pairing: replacement)
    monkeypatch.setattr(turret, '_request', lambda action, body=None: calls.append(action))
    monkeypatch.setattr(turret, 'status', lambda: {})
    return turret, old, replacement, frame, calls


def test_refocus_publishes_fresh_video_after_holding_and_clears_old_geometry(tmp_path, monkeypatch):
    turret, old, replacement, _, calls = refocusing_camera(tmp_path, monkeypatch)

    turret._refresh_guidance_camera(turret.job_cancel)

    assert calls == ['hold']
    assert old.closed and replacement.started and not replacement.closed
    assert turret.video is replacement
    assert not turret.refreshing_camera
    assert turret.tracker is turret.point is turret.calibration is turret.aim_reference is None


@pytest.mark.parametrize('cancel_kind', ['stop', 'replaced'])
@pytest.mark.parametrize('frame_ready', [False, True])
def test_cancelled_refocus_cannot_publish_video(tmp_path, monkeypatch, cancel_kind, frame_ready):
    turret, old, replacement, frame, _ = refocusing_camera(tmp_path, monkeypatch)
    obsolete = turret.job_cancel

    def observe():
        if cancel_kind == 'stop':
            turret.stop_follow()
        else:
            # Identity alone must reject an old worker, even before its event is set.
            turret.job_cancel = threading.Event()
        return frame if frame_ready else None

    monkeypatch.setattr(replacement, 'frame', observe)
    with pytest.raises(ValueError, match='refocus cancelled'):
        turret._refresh_guidance_camera(obsolete)

    assert old.closed and replacement.closed
    assert turret.video is None
    assert not turret.refreshing_camera


def test_old_refocus_cleanup_does_not_clear_new_camera_refresh(tmp_path, monkeypatch):
    turret, _, replacement, _, _ = refocusing_camera(tmp_path, monkeypatch)
    obsolete = turret.job_cancel

    def observe():
        turret.stop_follow()
        return None

    def close_old_candidate():
        replacement.closed = True
        # The close can block while another connect/guide acquires the lock and
        # begins its own camera replacement. Old cleanup must not clear its guard.
        turret.job_cancel = threading.Event()
        turret.phase = 'guiding'
        turret.refreshing_camera = True
        turret.camera_refresh_token = turret.job_cancel

    monkeypatch.setattr(replacement, 'frame', observe)
    monkeypatch.setattr(replacement, 'close', close_old_candidate)
    with pytest.raises(ValueError, match='refocus cancelled'):
        turret._refresh_guidance_camera(obsolete)

    assert turret.video is None
    assert turret.refreshing_camera
    assert turret.camera_refresh_token is turret.job_cancel


def test_refocus_close_failure_still_clears_its_camera_gap_guard(tmp_path, monkeypatch):
    turret, _, replacement, _, _ = refocusing_camera(tmp_path, monkeypatch)
    obsolete = turret.job_cancel

    def observe():
        turret.stop_follow()
        return None

    def close_failure():
        raise RuntimeError('Synthetic video process did not close')

    monkeypatch.setattr(replacement, 'frame', observe)
    monkeypatch.setattr(replacement, 'close', close_failure)
    with pytest.raises(RuntimeError, match='Synthetic video process'):
        turret._refresh_guidance_camera(obsolete)

    assert turret.video is None
    assert not turret.refreshing_camera
    assert turret.camera_refresh_token is None
