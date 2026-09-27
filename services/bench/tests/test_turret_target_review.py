"""Review regressions use only in-memory controller state; no hardware IO."""
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from ohmpath.devices.turret import Turret


class Tracker:
    def __init__(self, point):
        self.point = np.array(point, dtype=float)

    def update(self, frame):
        return self.point.copy()


class AcceptedMap:
    map_id = 'accepted-map'
    approved = True
    components = [{'id': 'first-component'}, {'id': 'second-component'}]

    def update(self, frame, context):
        pass

    def tracker(self, component_id):
        return Tracker((110, 120) if component_id == 'first-component' else (330, 250))


def ready(tmp_path, monkeypatch):
    turret = Turret(tmp_path)
    image = np.zeros((480, 640, 3), dtype=np.uint8)
    frame = {'image': image, 'sequence': 100, 'generation': 'synthetic-camera'}
    monkeypatch.setattr(turret, '_frame', lambda: frame)
    turret.video = SimpleNamespace(generation='synthetic-camera')
    turret.state = {'armed': True, 'moving': False, 'driving': False, 'commissioning': False,
                    'commanded_us': {'yaw': 1500, 'pitch': 1500},
                    'target_us': {'yaw': 1500, 'pitch': 1500}}
    turret.presence = time.monotonic()
    turret.component_map = AcceptedMap()
    turret.aim_reference = {'x': 0.45, 'y': 0.6, 'generation': 'synthetic-camera'}
    turret.tracker = turret.component_map.tracker('second-component')
    turret.point = turret.tracker.update(frame)
    turret.point_sequence = frame['sequence']
    return turret


def test_rejected_duplicate_tour_start_does_not_change_running_target(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.phase = 'tour'
    turret.tour = {'state': 'running', 'index': 2, 'total': 2, 'visited': ['first-component']}
    old_tracker, old_point, old_cancel = turret.tracker, turret.point.copy(), turret.job_cancel
    with pytest.raises(ValueError):
        turret.start_tour('accepted-map')
    assert turret.tracker is old_tracker
    np.testing.assert_array_equal(turret.point, old_point)
    assert turret.job_cancel is old_cancel
    assert not old_cancel.is_set()


def test_cancelled_calibration_worker_does_not_erase_current_calibration(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    obsolete = turret.job_cancel
    obsolete.set()
    turret.job_cancel = threading.Event()
    current = {'context': turret._context(), 'matrix': [[1, 0], [0, 1]],
               'origin_us': {'yaw': 1500, 'pitch': 1500}, 'calibration_revision': 'new-calibration'}
    turret.calibration = current
    with pytest.raises(ValueError, match='cancelled'):
        turret._calibrate(obsolete)
    assert turret.calibration is current


def test_stop_invalidates_old_job_before_any_later_move(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    old_cancel = turret.job_cancel
    calls = []
    monkeypatch.setattr(turret, '_request', lambda op, body=None: calls.append((op, body)))
    monkeypatch.setattr(turret, 'status', lambda: {})
    turret.stop_follow()
    with pytest.raises(ValueError, match='cancelled'):
        turret._move({'yaw': 1510, 'pitch': 1520}, old_cancel)
    assert calls == [('hold', None)]


def test_expired_tour_deadline_blocks_motor_command(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.job_deadline = time.monotonic() - 1
    calls = []
    monkeypatch.setattr(turret, '_request', lambda op, body=None: calls.append((op, body)))
    with pytest.raises(ValueError, match='time limit'):
        turret._move({'yaw': 1510, 'pitch': 1520}, turret.job_cancel)
    assert not calls


def test_alignment_does_not_count_same_observation_three_times(tmp_path, monkeypatch):
    turret = ready(tmp_path, monkeypatch)
    turret.calibration = {'context': turret._context(), 'matrix': [[1, 0], [0, 1]],
                          'origin_us': {'yaw': 1500, 'pitch': 1500}}
    turret.point = np.array([319.5, 239.5])
    monkeypatch.setattr(turret.tracker, 'update', lambda frame: turret.point.copy())
    cancel = turret.job_cancel
    polls = []

    def wait_without_new_observation(timeout):
        polls.append(timeout)
        if len(polls) == 3:
            cancel.set()

    monkeypatch.setattr(cancel, 'wait', wait_without_new_observation)
    # No supervisor exists in this fixture; sequence and tracked point never
    # refresh. Three samples must mean three observations, not three reads.
    with pytest.raises(ValueError, match='cancelled'):
        turret._follow(cancel)
