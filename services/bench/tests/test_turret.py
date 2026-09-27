from copy import deepcopy
import hashlib
import base64
import json
from pathlib import Path
import threading
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from ohmpath.api.app import create_app
from ohmpath.devices.turret import Turret
from ohmpath.devices.turret_link import VideoLink, load_pairing, ssh_args
from ohmpath.devices.turret_vision import PointTracker, fit_camera_map, correction
from ohmpath_pi.motion_state import DEFAULT_PROFILE, INITIAL_TEST_PROFILE, MotionState


class Driver:
    def __init__(self):
        self.releases = 0
    def arm(self, value): pass
    def move(self, value): pass
    def release(self): self.releases += 1
    def power_flags(self): return 0


class Control:
    def __init__(self):
        self.motion = MotionState(Driver())
        self.count = 0
        self.closed = False
    def request(self, op, body=None):
        self.count += 1
        return self.motion.request({'id': f'request-{self.count:06}', 'op': op,
            'epoch': self.motion.epoch, 'revision': self.motion.revision, 'body': body or {}})['status']
    def close(self): self.closed = True


class Video:
    generation = 'camera-generation'
    def __init__(self):
        self.image = np.random.default_rng(47).integers(0, 255, (360, 640, 3), dtype=np.uint8)
        self.sequence = 1
        self.stale = False
    def frame(self):
        return None if self.stale else {'sequence': self.sequence, 'generation': self.generation,
            'image': self.image, 'received': time.monotonic(), 'age': 0.0}
    def close(self): self.stale = True


def ready(tmp_path):
    value = Turret(tmp_path)
    value.control, value.video = Control(), Video()
    value.state = value.control.motion.status()
    value.keepalive()
    return value


def test_pairing_location_is_shared_across_packaged_and_normal_launches(tmp_path, monkeypatch):
    user_home = tmp_path / 'user'
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: user_home))
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path / 'packaged-private-appdata'))
    turret = Turret(tmp_path / 'bench')
    assert turret.pairing_path == user_home / '.ohmpath/hardware-setup/connection.json'
    explicit = tmp_path / 'explicit-pairing.json'
    assert Turret(tmp_path / 'bench', pairing_path=explicit).pairing_path == explicit
    with pytest.raises(ValueError, match='connection settings are missing'):
        load_pairing(turret.pairing_path)


def test_user_only_routes_and_inert_startup(tmp_path):
    app = create_app(tmp_path, 'u' * 40, 'm' * 40)
    with TestClient(app) as client:
        for method, path, body in [('get', 'status', None), ('get', 'frame', None),
                                   ('post', 'connect', {}), ('post', 'refocus', {}), ('post', 'teaching', {'enabled':True}), ('post', 'drive', {'yaw':1,'pitch':0,'fine':False,'session':'test-session','sequence':1}),
                                   ('post', 'arm', {'clear': True, 'laser_disconnected': True}),
                                   ('post', 'identify-components', {'roi':{'x':.1,'y':.1,'width':.8,'height':.8},'sequence':1,'generation':'test-camera'}),
                                   ('post', 'approve-components', {'map_id':'11111111-1111-4111-8111-111111111111'}),
                                   ('post', 'tour', {'map_id':'11111111-1111-4111-8111-111111111111'}),
                                   ('post', 'spot-reference', {'sequence':1,'generation':'test-camera'}),
                                   ('post', 'clear-components', {}),
                                   ('post', 'prepare-framing', {'roi':{'x':.1,'y':.1,'width':.8,'height':.8},'sequence':1,'generation':'test-camera'}),
                                   ('post', 'reposition', {'framing_id':'22222222-2222-4222-8222-222222222222'})]:
            kwargs = {'json': body} if body is not None else {}
            assert getattr(client, method)('/v1/turret/' + path, **kwargs).status_code == 401
            assert getattr(client, method)('/v1/turret/' + path, headers={'Authorization': 'Bearer ' + 'm'*40}, **kwargs).status_code == 403
        client.headers['Authorization'] = 'Bearer ' + 'u'*40
        assert client.get('/v1/turret/status').json()['armed'] is False
        assert client.get('/v1/turret/status').json()['commanded_us'] is None
        assert client.post('/v1/turret/refocus', json={'focus':3}).status_code == 422
        assert client.post('/v1/turret/arm', json={'clear': True, 'laser_disconnected': False}).status_code == 409
        assert client.post('/v1/turret/release', json={'command': 'anything'}).status_code == 422
        assert client.post('/v1/turret/drive', json={'yaw':True,'pitch':0,'fine':False,'session':'test-session','sequence':1}).status_code == 422
        assert client.post('/v1/turret/select', json={'x': -1.0, 'y': 0.5, 'sequence': 1, 'generation': 'test-camera'}).status_code == 422
        assert app.state.turret.control is None


def test_arm_needs_fresh_camera_and_presence_but_not_laser_disconnection(tmp_path):
    turret = ready(tmp_path)
    with pytest.raises(ValueError): turret.arm(clear=False, commissioning=False)
    turret.presence = 0
    with pytest.raises(ValueError): turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    turret.keepalive()
    turret.video.stale = True
    with pytest.raises(ValueError): turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    turret.video.stale = False
    assert turret.arm(clear=True, laser_disconnected=False, commissioning=False)['holding']
    turret.release()
    assert not turret.status()['armed']


def test_session_pause_clears_motion_even_without_desktop_bridge(tmp_path):
    app = create_app(tmp_path, 'u' * 40, 'm' * 40)
    turret = app.state.turret
    turret.control, turret.video = Control(), Video()
    turret.state = turret.control.motion.status()
    turret.keepalive()
    turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    control = turret.control
    with TestClient(app, headers={'Authorization':'Bearer '+'u'*40}) as client:
        session = client.post('/v1/sessions', json={'name':'Turret pause test'}).json()
        assert client.post('/v1/sessions/'+session['session_id']+'/pause', json={}).status_code == 200
        assert turret.control is None and not control.motion.armed and control.closed


def test_supervisor_releases_on_user_or_camera_loss(tmp_path):
    for reason in ('presence', 'camera'):
        turret = ready(tmp_path)
        turret.arm(clear=True, laser_disconnected=True, commissioning=False)
        if reason == 'presence': turret.presence = 0
        else: turret.video.stale = True
        stop = threading.Event()
        thread = threading.Thread(target=turret._loop, args=(stop,))
        thread.start()
        deadline = time.monotonic() + 2
        while turret.status()['armed'] and time.monotonic() < deadline: time.sleep(.02)
        stop.set(); thread.join(2)
        assert not turret.status()['armed']
        assert turret.control.motion.driver.releases >= 1
        turret.close()


def test_stale_selection_and_old_job_cannot_override_new_manual_move(tmp_path):
    turret = ready(tmp_path)
    with pytest.raises(ValueError, match='stale'):
        turret.select(.5, .5, 1, 'old-camera')
    assert turret.select(.5, .5, 1, turret.video.generation)['target_selected']
    turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    previous_job = turret.job_cancel
    turret.jog('yaw', 1, True)
    assert previous_job.is_set() and previous_job is not turret.job_cancel
    with pytest.raises(ValueError, match='cancelled'):
        turret._check_job(previous_job)
    assert turret.state['target_us']['yaw'] == 1505
    turret.close()


def test_calibration_invalidated_by_geometry_and_reference_never_verifies_laser(tmp_path):
    turret = ready(tmp_path)
    turret.calibration = {'context': turret._context(), 'matrix': [[1,0],[0,1]]}
    assert turret.status()['calibrated']
    turret.set_aim_reference(.6, .4, 300, 1, turret.video.generation)
    assert turret.status()['aim_reference']['physically_verified'] is False
    assert turret.status()['laser_enabled'] is False
    assert turret.status()['laser_control_available'] is False
    turret.rotate()
    assert not turret.status()['calibrated'] and turret.aim_reference is None
    turret.close()


def test_camera_fit_and_heldout_rejection_and_bounded_correction():
    matrix = np.array([[.2, -.05], [.06, -.25]])
    offsets = [np.array(v) for v in ((20,0),(-20,0),(0,50),(0,-50))]
    validation = np.array([10,25])
    mapping = fit_camera_map([(o, matrix @ o) for o in offsets], (validation, matrix @ validation))
    np.testing.assert_allclose(mapping['matrix'], matrix)
    with pytest.raises(ValueError, match='repeatable'):
        fit_camera_map([(o, matrix @ o) for o in offsets], (validation, matrix @ validation + 10))
    current = {'yaw': 1500, 'pitch': 1500}
    target, aligned = correction(mapping, np.array([325, 170]), (640,360), current, DEFAULT_PROFILE)
    assert not aligned and abs(target['yaw'] - 1500) <= 10 and abs(target['pitch'] - 1500) <= 20
    before = np.linalg.norm(np.array([319.5,179.5]) - np.array([325,170]))
    after = np.linalg.norm(np.array([319.5,179.5]) - (np.array([325,170]) + matrix @ np.array([target['yaw']-1500, target['pitch']-1500])))
    assert after < before
    _, aligned = correction(mapping, np.array([.6*639, .4*359]), (640,360), current, DEFAULT_PROFILE, (.6,.4))
    assert aligned
    with pytest.raises(ValueError, match='travel'):
        correction(mapping, np.array([100,100]), (640,360), {'yaw':DEFAULT_PROFILE['yaw']['max'],'pitch':1500}, DEFAULT_PROFILE)


def test_keyboard_sequence_and_stop_revoke_delayed_movement(tmp_path):
    turret = ready(tmp_path)
    turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    session = turret.drive_session
    assert turret.drive(1, 0, False, session, 1)['driving']
    with pytest.raises(ValueError): turret.save_position('home')
    assert not turret.drive(0, 0, False, session, 3)['driving']
    with pytest.raises(ValueError): turret.drive(1, 0, False, session, 2)
    turret.stop_follow()
    with pytest.raises(ValueError): turret.drive(1, 0, False, session, 4)
    session = turret.drive_session
    turret.video.stale = True
    with pytest.raises(ValueError): turret.drive(1, 0, False, session, 1)
    turret.video.stale = False; turret.presence = 0
    with pytest.raises(ValueError): turret.drive(1, 0, False, session, 2)
    turret.close()


def test_migrate_only_original_test_limits_preserving_saved_home(tmp_path):
    original = deepcopy(INITIAL_TEST_PROFILE); original['yaw']['home'] = 1510
    path = tmp_path / 'turret-profile.json'
    path.write_text(json.dumps({'profile': original, 'orientation': 90}))
    turret = Turret(tmp_path)
    assert turret.profile['yaw'] == {'min': 1300, 'max': 1700, 'home': 1510}
    assert turret.orientation == 90
    assert json.loads(path.read_text())['manual_range_revision'] == 2
    path.write_text(json.dumps({'profile': original, 'manual_range_revision': 2}))
    assert Turret(tmp_path).profile == original  # A subsequently taught narrow range remains narrow.
    original['yaw']['min'] = 1480
    path.write_text(json.dumps({'profile': original}))
    assert Turret(tmp_path).profile == original


def test_camera_jpeg_is_forwarded_without_reencoding_and_cached(tmp_path, monkeypatch):
    turret = ready(tmp_path)
    original_frame = turret.video.frame
    _, encoded = cv2.imencode('.jpg', turret.video.image)
    raw = encoded.tobytes()
    turret.video.frame = lambda: {**original_frame(), 'jpeg': raw}
    def unexpected(*args, **kwargs): raise AssertionError('Unnecessary JPEG encoding')
    monkeypatch.setattr(cv2, 'imencode', unexpected)
    first = turret.frame()['frame']
    assert base64.b64decode(first['jpeg_base64']) == raw
    assert turret.frame()['frame']['jpeg_base64'] is first['jpeg_base64']
    turret.video.stale = True
    turret.video.frame = original_frame
    assert turret.frame() == {'frame': None}
    turret.close()


def test_refocus_requires_released_outputs_and_invalidates_old_geometry(tmp_path, monkeypatch):
    turret = ready(tmp_path)
    turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    with pytest.raises(ValueError, match='Release motors'): turret.refocus()
    turret.release()
    turret.calibration = {'context':turret._context(), 'matrix':[[1,0],[0,1]]}
    turret.aim_reference = {'x':.5,'y':.5}
    turret.point = [20,30]
    old_video, old_control = turret.video, turret.control
    old_session = turret.drive_session
    expected = turret.connection_generation + 1
    def reconnect(*, expected_generation):
        assert expected_generation == expected == turret.connection_generation
        assert turret.calibration is None and turret.aim_reference is None and turret.point is None
        assert not turret.status()['armed']
        return turret.status()
    monkeypatch.setattr(turret, 'connect', reconnect)
    assert not turret.refocus()['armed']
    assert old_video.stale and old_control.closed and turret.drive_session != old_session


def test_refocus_cannot_reconnect_after_a_later_disconnect(tmp_path):
    turret = Turret(tmp_path)
    expected = turret.connection_generation
    turret.disconnect()
    with pytest.raises(ValueError, match='cancelled'): turret.connect(expected_generation=expected)
    assert turret.control is None


def test_hd_stream_locks_focus_contract_for_each_generation():
    video = VideoLink({})
    header = {'protocol':3,'length':800_000,'focus_dioptres':4.25,'focus_locked':True,'focus_success':True}
    assert video._validate_header(header) == 800_000
    assert video._validate_header(dict(header)) == 800_000
    for updates in ({'protocol':2}, {'length':2_000_001}, {'focus_locked':False},
                    {'focus_dioptres':float('nan')}, {'focus_dioptres':4.5}, {'focus_success':'yes'}):
        with pytest.raises(RuntimeError): video._validate_header({**header, **updates})


def test_rotated_preview_preserves_hd_detail_and_uses_high_jpeg_quality(tmp_path, monkeypatch):
    turret = ready(tmp_path)
    turret.video.image = np.zeros((720,1280,3), dtype=np.uint8)
    turret.orientation = 90
    encode = cv2.imencode
    calls = []
    def record(extension, image, options):
        calls.append((image.shape, options))
        return encode(extension, image, options)
    monkeypatch.setattr(cv2, 'imencode', record)
    frame = turret.frame()['frame']
    assert (frame['width'], frame['height']) == (720,1280)
    assert calls == [((1280,720,3), [cv2.IMWRITE_JPEG_QUALITY,95])]
    turret.close()


def test_teaching_revokes_old_keys_preserves_pose_and_requires_current_presence(tmp_path):
    turret = ready(tmp_path)
    turret.arm(clear=True, laser_disconnected=True, commissioning=False)
    session = turret.drive_session
    turret.control.motion.position = [1700, 1500]
    value = turret.teaching(True)
    assert value['commissioning'] and value['commanded_us']['yaw'] == 1700
    assert value['drive_session'] != session
    with pytest.raises(ValueError): turret.drive(1, 0, False, session, 9)
    turret.jog('yaw', 1, False)
    assert turret.state['target_us']['yaw'] == 1750
    turret.stop_follow()
    turret.control.motion.position = [1800, 1500]
    turret.stop_follow()
    old_session = turret.drive_session
    turret.save_position('max', 'yaw')
    assert turret.drive_session != old_session
    assert turret.profile['yaw']['max'] == 1800
    assert not turret.teaching(False)['commissioning']
    assert turret.status()['manual_bounds_us'] is None
    turret.presence = 0
    with pytest.raises(ValueError): turret.teaching(True)
    turret.close()


def test_tracker_observes_synthetic_shift_and_loses_flat_image():
    source = Video()
    tracker = PointTracker()
    first = tracker.update(source.frame(), (.5,.5))
    source.sequence += 1
    source.image = cv2.warpAffine(source.image, np.float32([[1,0,7],[0,1,-5]]), (640,360))
    second = tracker.update(source.frame())
    np.testing.assert_allclose(second-first, [7,-5], atol=1)
    source.sequence += 1; source.image.fill(128)
    with pytest.raises(ValueError): tracker.update(source.frame())


def test_pairing_pins_identity_and_separates_camera_from_control(tmp_path):
    key = b'synthetic-host-key'
    known = tmp_path/'known_hosts'; known.write_text('raspi.local ssh-ed25519 '+base64.b64encode(key).decode())
    identity = tmp_path/'identity'; identity.write_text('synthetic test fixture')
    config = {'host':'192.168.50.2','user':'talia','host_alias':'raspi.local',
        'fingerprint':'SHA256:'+base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip('='),
        'identity_file':str(identity),'known_hosts_file':str(known),'remote_root':'/home/talia/.local/share/ohmpath/current'}
    path = tmp_path/'pairing.json'; path.write_text(json.dumps(config))
    value = load_pairing(path)
    control, video = ssh_args(value,'control'), ssh_args(value,'video')
    assert 'StrictHostKeyChecking=yes' in control and 'ControlMaster=no' in control
    assert 'WatchdogSec=2s' in control[-1] and 'ExecStopPost=' in control[-1]
    assert 'motion_worker' not in video[-1] and 'camera_worker' in video[-1]
    config['fingerprint'] += 'x'; path.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='identity changed'): load_pairing(path)
