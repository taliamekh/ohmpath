"""Production observation timing with synthetic images; no devices or model calls."""
from types import SimpleNamespace
import threading

import cv2
import numpy as np
import pytest

import ohmpath.devices.turret as runtime
from ohmpath.devices.turret_framing import SceneFraming
from ohmpath.devices.turret_targets import ComponentMap
from test_turret_scene import texture


class Clock:
    def __init__(self):
        self.now = 100.

    def monotonic(self):
        return self.now


class OneTick:
    """Run one actual supervisor iteration without a background thread."""
    def __init__(self):
        self.count = 0

    def wait(self, timeout):
        self.count += 1
        return self.count > 1

    def is_set(self):
        return False


class Cancellation:
    def __init__(self, rig):
        self.rig = rig
        self.cancelled = False

    def set(self):
        self.cancelled = True

    def is_set(self):
        return self.cancelled

    def wait(self, timeout):
        if not self.cancelled:
            self.rig.clock.now += timeout
            self.rig.tick()
        return self.cancelled


class Control:
    def __init__(self, clock):
        self.clock = clock
        self.position = {'yaw': 1500., 'pitch': 2004.}
        self.target = dict(self.position)
        self.started = None
        self.ended = None
        self.armed = True
        self.revision = 'profile-one'
        self.requests = []

    def status(self):
        moving = self.ended is not None and self.clock.now < self.ended
        if not moving:
            self.position = dict(self.target)
        return {'armed': self.armed, 'holding': self.armed, 'moving': moving,
                'driving': False, 'commissioning': False, 'revision': self.revision,
                'firmware_revision': 'firmware-one', 'commanded_us': dict(self.position),
                'target_us': dict(self.target)}

    def request(self, operation, body=None):
        self.requests.append((operation, dict(body or {})))
        if operation == 'move':
            self.target = dict(body)
            self.started = self.clock.now
            self.ended = self.started + .24
        elif operation == 'hold':
            self.ended = self.clock.now
        elif operation == 'release':
            self.armed = False
        return self.status()


class Video:
    generation = 'synthetic-motion-camera'

    def __init__(self, rig):
        self.rig = rig
        self.reference = texture()
        rng = np.random.default_rng(915)
        self.reference[215:265, 295:345] = cv2.resize(
            rng.integers(20, 235, (10, 10, 3), dtype=np.uint8), (50, 50),
            interpolation=cv2.INTER_NEAREST)
        self.mode = 'normal'
        self.unavailable = False

    def frame(self):
        if self.unavailable:
            return None
        clock, control = self.rig.clock, self.rig.control
        image = self.reference
        sequence = 1 + round((clock.now - 100.) / .01)
        received, age = clock.now, 0.
        if control.started is not None:
            if self.mode == 'old_sequence':
                sequence = 1
            elif self.mode == 'old_capture':
                # New packet/sequence, but its exposure still belongs to the ramp.
                age = clock.now - control.started
            if clock.now < control.ended + .20:
                image = np.full_like(image, 135)  # Featureless motion blur.
            elif self.mode == 'missing_scene':
                image = np.full_like(image, 135)
            else:
                dx = .5 * (control.target['yaw'] - 1500.)
                dy = .4 * (control.target['pitch'] - 2004.)
                image = cv2.warpAffine(image, np.float32([[1, 0, dx], [0, 1, dy]]), (640, 480))
                if self.mode == 'missing_target':
                    x, y = round(320 + dx), round(240 + dy)
                    image[y-35:y+35, x-35:x+35] = 135
        return {'image': image, 'generation': self.generation, 'sequence': sequence,
                'received': received, 'age': age}


class Identifier:
    def start(self, context, image_id, jpeg):
        self.image_id = image_id
        return {'turn_id': 'synthetic-identification'}

    def status(self, turn_id):
        return {'status': 'completed', 'answer': {'annotations': [
            {'image_id': self.image_id, 'x': .5, 'y': .5, 'label': 'Header'}]}}

    def cancel(self, context):
        pass


class Rig:
    def __init__(self, tmp_path, monkeypatch, *, track_component=False):
        self.clock = Clock()
        monkeypatch.setattr(runtime, 'time', SimpleNamespace(monotonic=self.clock.monotonic))
        self.control = Control(self.clock)
        self.turret = runtime.Turret(tmp_path)
        self.turret.control = self.control
        self.video = Video(self)
        self.turret.video = self.video
        self.turret.state = self.control.status()
        self.turret.presence = self.clock.now
        self.cancel = Cancellation(self)
        self.turret.job_cancel = self.cancel
        self.turret.phase = 'guiding'
        self.turret.guidance = {'state': 'running'}
        self.on_tick = None
        self.maintain_presence = True
        reference = self.video.frame()
        roi = {'x': .2, 'y': .2, 'width': .6, 'height': .6}
        mapped = ComponentMap(reference, roi, self.turret._context(), Identifier())
        mapped.approve(mapped.map_id, reference, self.turret._context())
        self.turret.component_map = mapped
        framing = SceneFraming.from_scene(mapped.scene)
        self.turret.framing_tracker = framing
        self.turret.framing = {'state': 'running', 'framing_id': 'synthetic-framing'}
        self.turret.tracker = mapped.tracker(mapped.components[0]['id']) if track_component else framing
        self.turret.point = self.turret.tracker.update(reference)
        self.turret.point_sequence = reference['sequence']
        self.observations = []
        # Record real registrations rather than replacing their acceptance logic.
        update = mapped.scene.update

        def observed(frame):
            self.observations.append((self.clock.now, frame['sequence'], frame['received'] - frame['age']))
            return update(frame)

        monkeypatch.setattr(mapped.scene, 'update', observed)

    def tick(self):
        if self.on_tick:
            self.on_tick(self)
        if self.maintain_presence:
            self.turret.presence = self.clock.now
        self.turret._loop(OneTick())

    def move(self):
        return self.turret._move({'yaw': 1520., 'pitch': 2014.}, self.cancel)

    def move_requests(self):
        return [body for operation, body in self.control.requests if operation == 'move']


@pytest.mark.parametrize('track_component', [False, True])
def test_blurred_ramp_and_quiet_frames_do_not_poison_real_scene(tmp_path, monkeypatch, track_component):
    rig = Rig(tmp_path, monkeypatch, track_component=track_component)
    original = rig.turret.point.copy()

    observed = rig.move()

    np.testing.assert_allclose(observed, original + [10, 4], atol=2)
    assert rig.turret.component_map.phase == 'ready'
    assert rig.turret.framing_tracker.summary()['geometry_current']
    assert not rig.cancel.is_set()
    assert not rig.turret.observation_paused
    assert len(rig.move_requests()) == 1
    assert sum(operation == 'heartbeat' for operation, _ in rig.control.requests) >= 4
    assert len({sequence for _, sequence, _ in rig.observations}) >= 4
    assert all(captured >= rig.control.ended + .25 - 1e-8 for _, _, captured in rig.observations)


def test_settled_steps_refresh_actual_beam_through_gradual_parallax(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    original_frame = rig.video.frame

    def beam_frame():
        result = original_frame()
        result['image'] = result['image'].copy()
        result['image'][:120, :120] = 50
        y = 80 + round(.6 * (rig.control.target['pitch'] - 2004))
        cv2.circle(result['image'], (80, y), 4, (20, 20, 255), -1)
        return result

    monkeypatch.setattr(rig.video, 'frame', beam_frame)
    rig.turret.aim_reference = {'x': 80/639, 'y': 80/479,
                               'generation': rig.video.generation, 'orientation': 0,
                               'source': 'observed_red_spot'}
    for pitch in (2014., 2024., 2034.):
        rig.turret._move({'yaw': 1520., 'pitch': pitch}, rig.cancel)
        assert rig.turret.aim_reference['y'] * 479 == pytest.approx(80 + .6 * (pitch-2004), abs=.5)
    # The total displacement exceeds the local seed window, but every reference
    # came from a fresh observed core on the actual settled trajectory.
    assert rig.turret.aim_reference['y'] * 479 == pytest.approx(98., abs=.5)
    assert rig.turret.aim_reference['sequence'] > 1


@pytest.mark.parametrize('mode', ['missing_scene', 'missing_target'])
def test_settled_scene_or_target_loss_stops_before_next_calibration_move(tmp_path, monkeypatch, mode):
    rig = Rig(tmp_path, monkeypatch, track_component=True)
    rig.video.mode = mode

    with pytest.raises(ValueError):
        rig.turret._calibrate(rig.cancel)
    rig.tick()

    assert len(rig.move_requests()) == 1
    assert rig.cancel.is_set()
    assert not rig.turret.observation_paused
    assert any(operation == 'hold' for operation, _ in rig.control.requests)
    assert rig.turret.phase == 'idle'


@pytest.mark.parametrize('mode', ['old_sequence', 'old_capture'])
def test_pre_movement_exposure_cannot_settle_or_authorize_next_move(tmp_path, monkeypatch, mode):
    rig = Rig(tmp_path, monkeypatch)
    rig.video.mode = mode

    with pytest.raises(ValueError, match='did not settle'):
        rig.turret._calibrate(rig.cancel)

    assert len(rig.move_requests()) == 1
    assert rig.observations == []
    assert not rig.turret.observation_paused
    assert rig.turret.calibration is None


@pytest.mark.parametrize('change', ['generation', 'profile', 'orientation'])
def test_context_change_during_ramp_cannot_authorize_next_move(tmp_path, monkeypatch, change):
    rig = Rig(tmp_path, monkeypatch)

    def change_context(rig):
        if rig.clock.now < 100.1:
            return
        if change == 'generation':
            rig.video.generation = 'replacement-camera'
        elif change == 'profile':
            rig.control.revision = 'replacement-profile'
        else:
            rig.turret.orientation = 180
        rig.on_tick = None

    rig.on_tick = change_context
    with pytest.raises(ValueError, match='settings changed'):
        rig.turret._calibrate(rig.cancel)

    assert len(rig.move_requests()) == 1
    assert rig.observations == []
    assert not rig.turret.observation_paused
    assert rig.turret.calibration is None


@pytest.mark.parametrize('loss', ['stop', 'camera', 'presence'])
def test_suspended_registration_keeps_stop_camera_and_presence_guards(tmp_path, monkeypatch, loss):
    rig = Rig(tmp_path, monkeypatch)

    def interrupt(rig):
        if rig.clock.now < 100.1:
            return
        if loss == 'stop':
            rig.turret.stop_follow()
        elif loss == 'camera':
            rig.video.unavailable = True
        else:
            rig.maintain_presence = False
            rig.turret.presence = rig.clock.now - 1.
        rig.on_tick = None

    rig.on_tick = interrupt
    with pytest.raises(ValueError, match='cancelled|released|lost'):
        rig.turret._calibrate(rig.cancel)

    assert len(rig.move_requests()) == 1
    assert rig.cancel.is_set()
    assert rig.observations == []
    assert not rig.turret.observation_paused
    if loss in ('camera', 'presence'):
        assert not rig.control.armed


def test_stop_between_move_preparation_and_send_prevents_stale_command(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)

    class StopAfterUnlock:
        def __init__(self, lock):
            self.lock = lock
            self.pending = True
            self.depth = 0

        def __enter__(self):
            self.lock.__enter__()
            self.depth += 1

        def __exit__(self, *args):
            self.depth -= 1
            self.lock.__exit__(*args)
            if self.depth == 0 and self.pending:
                # Represents another request obtaining the released runtime lock.
                self.pending = False
                rig.turret.stop_follow()

    rig.turret.lock = StopAfterUnlock(rig.turret.lock)
    with pytest.raises(ValueError, match='cancelled|released'):
        rig.move()

    assert rig.cancel.is_set()
    assert rig.move_requests() == []
    assert not rig.turret.observation_paused


def test_cancelled_worker_cannot_clear_replacement_workers_observation_pause(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    entered = [threading.Event(), threading.Event()]
    resume = [threading.Event(), threading.Event()]
    errors = {}

    def settling(cancel, timeout=2.5):
        index = 0 if cancel is rig.cancel else 1
        entered[index].set()
        assert resume[index].wait(2), 'Synthetic worker was not resumed.'
        rig.turret._check_job(cancel)
        return rig.turret.point.copy()

    monkeypatch.setattr(rig.turret, '_settle', settling)

    def move(index, cancel):
        try:
            rig.turret._move({'yaw': 1510. + index * 10, 'pitch': 2004.}, cancel)
        except Exception as error:
            errors[index] = error

    workers = [threading.Thread(target=move, args=(0, rig.cancel))]
    try:
        workers[0].start()
        assert entered[0].wait(1)
        rig.turret.stop_follow()
        # Stop makes the runtime idle while its cancelled worker can still unwind.
        workers.append(threading.Thread(target=move, args=(1, rig.turret.job_cancel)))
        workers[1].start()
        assert entered[1].wait(1)
        resume[0].set()
        workers[0].join(1)
        assert not workers[0].is_alive()
        assert isinstance(errors.get(0), ValueError)
        assert rig.turret.observation_paused, 'Old finally resumed observation during the replacement move.'
        resume[1].set()
        workers[1].join(1)
        assert not workers[1].is_alive()
        assert 1 not in errors
        assert not rig.turret.observation_paused, 'No finished worker may leave registration suspended.'
    finally:
        for event in resume:
            event.set()
        for worker in workers:
            worker.join(2)
