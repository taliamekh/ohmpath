from copy import deepcopy

import pytest

from ohmpath_pi.motion_state import DEFAULT_PROFILE, MotionState


class Driver:
    def __init__(self):
        self.outputs = []
        self.flags = 0
        self.released = 0

    def arm(self, value):
        self.outputs.append(value)

    def move(self, value):
        self.outputs.append(value)

    def release(self):
        self.released += 1

    def power_flags(self):
        return self.flags


@pytest.fixture
def state():
    clock = [10.0]
    value = MotionState(Driver(), clock=lambda: clock[0])
    value.test_clock = clock
    return value


def request(state, op, body=None, ident=None):
    return {'id': ident or f'request-{len(state.ledger):08}-{op}', 'op': op,
            'epoch': state.epoch, 'revision': state.revision, 'body': body or {}}


def arm(state, commissioning=False):
    state.request(request(state, 'arm', {'clear': True, 'commissioning': commissioning}))


def test_construction_is_inert_and_arm_requires_fresh_clearance(state):
    assert state.driver.outputs == []
    assert state.status()['commanded_us'] is None and state.status()['target_us'] is None
    with pytest.raises(ValueError):
        state.request(request(state, 'arm', {'clear': False, 'commissioning': False}))
    arm(state)
    assert state.driver.outputs == [(1500.0, 1500.0)]
    assert state.status()['holding'] and not state.status()['position_verified']


def test_reconnect_never_labels_default_values_as_a_sent_command(state):
    arm(state)
    state.request(request(state, 'jog', {'axis':'pitch','direction':1,'fine':False}))
    state.test_clock[0] += .1
    state.tick()
    actual_command = state.status()['commanded_us']
    state.release()
    assert state.status()['commanded_us'] == actual_command
    assert not state.status()['holding'] and not state.status()['position_verified']
    restarted = MotionState(Driver())
    assert restarted.status()['commanded_us'] is None
    assert restarted.driver.outputs == []


def test_ramp_limits_speed_and_home_holds_instead_of_releasing(state):
    arm(state)
    state.request(request(state, 'move', {'yaw': 1525, 'pitch': 1600}))
    state.test_clock[0] += 0.02
    state.tick()
    assert state.position == pytest.approx([1503, 1503])
    state.request(request(state, 'home'))
    state.test_clock[0] += 0.02
    state.tick()
    assert state.position == [1500, 1500]
    assert state.armed and state.driver.released == 0


def test_heartbeat_expiry_releases_and_old_epoch_cannot_rearm(state):
    arm(state)
    stale = request(state, 'arm', {'clear': True, 'commissioning': False}, 'old-request-epoch')
    state.test_clock[0] += 1.6
    state.tick()
    assert not state.armed and state.driver.released == 1
    with pytest.raises(ValueError, match='session'):
        state.request(stale)


def test_duplicate_move_is_not_reexecuted_and_changed_payload_rejected(state):
    arm(state)
    command = request(state, 'jog', {'axis': 'yaw', 'direction': 1, 'fine': True})
    state.request(command)
    target = list(state.target)
    assert state.request(command)['replayed']
    assert state.target == target
    command['body']['direction'] = -1
    with pytest.raises(ValueError, match='reused'):
        state.request(command)


def test_bounds_nonfinite_and_boolean_inputs_rejected(state):
    arm(state)
    for value in (1800, float('inf'), float('nan'), True):
        with pytest.raises(ValueError):
            state.request(request(state, 'move', {'yaw': value, 'pitch': 1500}, f'bad-{value}-value'))
    assert state.target == [1500, 1500]


def test_power_warning_releases_outputs(state):
    arm(state)
    state.driver.flags = 0x10000
    state.test_clock[0] += 0.3
    state.tick()
    assert not state.armed and state.driver.released == 1


def test_commissioning_only_allows_small_manual_jogs(state):
    arm(state, commissioning=True)
    state.request(request(state, 'jog', {'axis': 'yaw', 'direction': 1, 'fine': False}))
    assert state.target[0] == 1550
    with pytest.raises(ValueError, match='Automatic movement'):
        state.request(request(state, 'move', {'yaw': 1510, 'pitch': 1500}))


def test_profile_updates_keep_position_in_bounds_and_invalidate_revision(state):
    arm(state)
    profile = deepcopy(DEFAULT_PROFILE)
    profile['yaw']['home'] = 1510
    previous = state.revision
    state.request(request(state, 'profile', {'profile': profile}))
    assert previous != state.revision
    assert state.armed and state.position == [1500, 1500]
    invalid = deepcopy(profile)
    invalid['yaw']['min'] = 1501
    with pytest.raises(ValueError, match='include the current'):
        state.request(request(state, 'profile', {'profile': invalid}))


def test_drive_repeats_smoothly_and_key_release_holds(state):
    arm(state)
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': -1, 'fine': False}))
    for _ in range(5):
        state.test_clock[0] += .02; state.tick()
    assert state.position == pytest.approx([1515, 1485])
    state.request(request(state, 'drive', {'yaw': 0, 'pitch': 0, 'fine': False}))
    held = list(state.position)
    state.test_clock[0] += .1; state.tick()
    assert state.position == held and state.armed and not state.status()['driving']


def test_drive_lease_expires_even_with_heartbeat_and_replayed_request(state):
    arm(state)
    command = request(state, 'drive', {'yaw': 1, 'pitch': 0, 'fine': False})
    state.request(command)
    state.test_clock[0] += .2; state.tick()
    held = list(state.position)
    state.request(request(state, 'heartbeat'))
    assert state.request(command)['replayed']
    state.test_clock[0] += .2; state.tick()
    assert state.position == held and not state.status()['driving'] and state.armed


def test_drive_clamps_both_axes_and_rejects_invalid_directions(state):
    arm(state)
    for body in ({'yaw': True, 'pitch': 0, 'fine': False}, {'yaw': 2, 'pitch': 0, 'fine': False}, {'yaw': 1, 'pitch': 0, 'fine': 1}):
        with pytest.raises(ValueError): state.request(request(state, 'drive', body))
    state.position = [1699, 1351]
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': -1, 'fine': False}))
    state.test_clock[0] += .1; state.tick()
    assert state.position == [1700, 1350]
    state.request(request(state, 'hold'))
    state.test_clock[0] += .1; state.tick()
    assert not state.status()['driving']


def test_normal_step_is_larger_fine_drive_slower_and_release_cancels(state):
    arm(state)
    state.request(request(state, 'jog', {'axis': 'yaw', 'direction': 1, 'fine': False}))
    assert state.target[0] == 1550
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': 0, 'fine': True}))
    state.test_clock[0] += .1; state.tick()
    assert state.position == pytest.approx([1505, 1500])
    state.request(request(state, 'release'))
    state.test_clock[0] += .1; state.tick()
    assert not state.armed and not state.status()['driving']


def test_teaching_bypasses_saved_limits_without_home_jump_or_replacement_travel_clamp(state):
    arm(state)
    state.position = [1699, 1500]
    before = list(state.driver.outputs)
    state.request(request(state, 'teaching', {'enabled': True}))
    assert state.position == [1699, 1500] and state.target == state.position
    assert state.driver.outputs == before and state.commissioning
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': 0, 'fine': False}))
    state.test_clock[0] += .1; state.tick()
    assert state.position[0] == pytest.approx(1714)  # Crosses the old saved endpoint.
    with pytest.raises(ValueError, match='Save this endpoint'):
        state.request(request(state, 'teaching', {'enabled': False}))
    assert state.commissioning and not any(state.drive_direction)
    profile = deepcopy(state.profile); profile['yaw']['max'] = 1800
    state.request(request(state, 'profile', {'profile': profile}))
    state.request(request(state, 'teaching', {'enabled': False}))
    assert not state.commissioning and state.position[0] == pytest.approx(1714)
    state.request(request(state, 'teaching', {'enabled': True}))
    state.position = [2499, 501]
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': -1, 'fine': False}))
    state.test_clock[0] += .1; state.tick()
    assert state.position == pytest.approx([2514, 486])
    assert state.status()['at_limit'] == {'yaw': None, 'pitch': None}
    assert state.status()['manual_bounds_us'] is None


def test_extended_teaching_passes_old_1000_2000_stops_and_can_save_new_ends(state):
    arm(state, commissioning=True)
    state.position = [995, 2005]
    state.request(request(state, 'drive', {'yaw': -1, 'pitch': 1, 'fine': False}))
    state.test_clock[0] += .1; state.tick()
    assert state.position == pytest.approx([980, 2020])
    assert state.status()['active_bounds_us'] is None
    profile = deepcopy(DEFAULT_PROFILE)
    profile['yaw']['min'] = 800; profile['pitch']['max'] = 2300
    state.request(request(state, 'profile', {'profile': profile}))
    state.request(request(state, 'teaching', {'enabled': False}))
    assert state.status()['active_bounds_us']['pitch']['max'] == 2300


def test_manual_jog_accepts_user_taught_ends_beyond_old_ranges(state):
    arm(state, commissioning=True)
    state.position = [400, 2600]; state.target = list(state.position)
    state.request(request(state, 'jog', {'axis': 'pitch', 'direction': 1, 'fine': False}))
    assert state.target[1] == 2650
    profile = deepcopy(DEFAULT_PROFILE)
    profile['yaw']['min'] = 400; profile['pitch']['max'] = 2650
    state.request(request(state, 'profile', {'profile': profile}))
    assert state.profile['pitch']['max'] == 2650


def test_manual_input_that_cannot_fit_pwm_frame_releases_without_writing(state):
    arm(state, commissioning=True)
    state.position = [19995, 1500]; state.target = list(state.position)
    state.request(request(state, 'drive', {'yaw': 1, 'pitch': 0, 'fine': False}))
    before = list(state.driver.outputs)
    state.test_clock[0] += .1
    with pytest.raises(ValueError, match='cannot be represented'): state.tick()
    assert not state.armed and not state.drive_direction[0]
    assert state.driver.outputs == before and state.driver.released == 1


def test_teaching_is_explicit_armed_only_and_blocks_automatic_moves(state):
    with pytest.raises(ValueError): state.request(request(state, 'teaching', {'enabled': True}))
    arm(state)
    for body in ({'enabled': 1}, {'enabled': True, 'extra': True}):
        with pytest.raises(ValueError): state.request(request(state, 'teaching', body))
    state.request(request(state, 'teaching', {'enabled': True}))
    with pytest.raises(ValueError, match='Automatic movement'):
        state.request(request(state, 'move', {'yaw': 1510, 'pitch': 1500}))
