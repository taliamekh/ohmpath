"""Deterministic, bounded manual motion state. No vision/model command authority."""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import math
import secrets
import time
from typing import Any
from .pwm import MIN_PULSE_US, MAX_PULSE_US, checked_positions

INITIAL_TEST_PROFILE = {'yaw': {'min': 1475, 'max': 1525, 'home': 1500},
                        'pitch': {'min': 1400, 'max': 1600, 'home': 1500}}
# Wider manual envelope requested after the owner confirmed assembly clearance.
# Pulse widths are commands, not measured shaft angles or mechanical limits.
DEFAULT_PROFILE = {'yaw': {'min': 1300, 'max': 1700, 'home': 1500},
                   'pitch': {'min': 1350, 'max': 1650, 'home': 1500}}
HEARTBEAT_S = 1.5
SPEED_US_S = 150.0
DRIVE_LEASE_S = 0.35


def profile_checked(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) != {'yaw', 'pitch'}:
        raise ValueError('Both axis profiles are required.')
    result = {}
    for axis in ('yaw', 'pitch'):
        row = value[axis]
        if not isinstance(row, dict) or set(row) != {'min', 'max', 'home'}:
            raise ValueError('Axis profile needs minimum, maximum and home.')
        if any(type(x) is not int for x in row.values()):
            raise ValueError('Axis profile values must be integers.')
        if not MIN_PULSE_US <= row['min'] < row['max'] <= MAX_PULSE_US or not row['min'] <= row['home'] <= row['max']:
            raise ValueError('Saved endpoints must form a valid PWM range containing home.')
        result[axis] = dict(row)
    return result


def revision(profile: dict) -> str:
    return hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()[:20]


class MotionState:
    def __init__(self, driver, *, clock=time.monotonic) -> None:
        self.driver = driver
        self.clock = clock
        self.profile = profile_checked(DEFAULT_PROFILE)
        self.revision = revision(self.profile)
        self.epoch = secrets.token_hex(16)
        self.armed = False
        self.commissioning = False
        self.position = [1500.0, 1500.0]
        self.command_known = False
        self.target = list(self.position)
        self.last_heartbeat = 0.0
        self.last_tick = clock()
        self.last_power = 0.0
        self.fault: str | None = None
        self.firmware_revision = 'development'
        self.drive_direction = [0, 0]
        self.drive_until = 0.0
        self.drive_fine = False
        self.ledger: OrderedDict[str, tuple[str, dict]] = OrderedDict()

    def status(self) -> dict:
        bounds = None if self.commissioning else {
            axis: {key: self.profile[axis][key] for key in ('min', 'max')} for axis in ('yaw', 'pitch')}
        return {'armed': self.armed, 'epoch': self.epoch, 'revision': self.revision,
                'firmware_revision': self.firmware_revision,
                'profile': self.profile, 'commanded_us': dict(zip(('yaw', 'pitch'), self.position)) if self.command_known else None,
                'target_us': dict(zip(('yaw', 'pitch'), self.target)) if self.command_known else None,
                'moving': self.armed and any(abs(a - b) > 0.5 for a, b in zip(self.position, self.target)),
                'driving': self.armed and any(self.drive_direction) and self.clock() < self.drive_until,
                'position_verified': False, 'holding': self.armed, 'fault': self.fault,
                'commissioning': self.commissioning, 'laser_enabled': False,
                'manual_bounds_us': None, 'active_bounds_us': bounds,
                'signal_bounds_us': {'min': MIN_PULSE_US, 'max': MAX_PULSE_US},
                'at_limit': {axis: None if bounds is None or not self.armed else 'lower' if value <= bounds[axis]['min'] else 'upper' if value >= bounds[axis]['max'] else None
                             for axis, value in zip(('yaw', 'pitch'), self.position)}}

    def release(self, reason: str | None = None) -> None:
        self.armed = False
        self.commissioning = False
        self.drive_direction = [0, 0]
        self.drive_until = 0.0
        self.target = list(self.position)
        self.epoch = secrets.token_hex(16)
        self.fault = reason
        self.driver.release()

    def tick(self) -> None:
        now = self.clock()
        elapsed = min(max(now - self.last_tick, 0), 0.1)
        self.last_tick = now
        if not self.armed:
            return
        if now - self.last_heartbeat > HEARTBEAT_S:
            self.release('Connection heartbeat expired. Enable control again after checking the mechanism.')
            return
        if now - self.last_power > 0.2:
            self.last_power = now
            if self.driver.power_flags() != 0:
                self.release('The Pi reported a power or thermal warning. Check the supply and load.')
                return
        if any(self.drive_direction):
            if now >= self.drive_until:
                self.drive_direction = [0, 0]
                self.target = list(self.position)
            else:
                speed = 50.0 if self.drive_fine else SPEED_US_S
                desired = [value + direction * speed * elapsed for value, direction in zip(self.position, self.drive_direction)]
                self.target = desired if self.commissioning else [
                    max(self.profile[axis]['min'], min(self.profile[axis]['max'], value))
                    for axis, value in zip(('yaw', 'pitch'), desired)]
        step = SPEED_US_S * elapsed
        updated = [a + max(-step, min(step, b - a)) for a, b in zip(self.position, self.target)]
        if updated != self.position:
            try:
                checked_positions(updated)
                self.driver.move(tuple(updated))
                self.position = updated
            except Exception:
                self.release('Servo output failed; physical position is unknown.')
                raise

    def request(self, request: dict) -> dict:
        if not isinstance(request, dict) or set(request) != {'id', 'op', 'epoch', 'revision', 'body'}:
            raise ValueError('Invalid motion message.')
        ident, op, body = request['id'], request['op'], request['body']
        if not isinstance(ident, str) or not 8 <= len(ident) <= 80 or not isinstance(body, dict) or not isinstance(op, str):
            raise ValueError('Invalid motion message identifier or body.')
        digest = hashlib.sha256(json.dumps(request, sort_keys=True, allow_nan=False).encode()).hexdigest()
        if ident in self.ledger:
            previous, result = self.ledger[ident]
            if previous != digest:
                raise ValueError('A command ID cannot be reused with different content.')
            return {**result, 'replayed': True, 'status': self.status()}
        if op not in ('status', 'release') and (request['epoch'] != self.epoch or request['revision'] != self.revision):
            raise ValueError('The control session or settings changed. Reconnect before moving.')
        if op in ('status', 'release', 'heartbeat', 'home', 'hold') and body:
            raise ValueError('Unexpected command fields.')
        if op == 'status':
            pass
        elif op == 'release':
            self.release()
        elif op == 'heartbeat':
            self.last_heartbeat = self.clock()
        elif op == 'hold':
            self.drive_direction = [0, 0]
            self.target = list(self.position)
        elif op == 'profile':
            if set(body) != {'profile'}:
                raise ValueError('Invalid profile request.')
            updated = profile_checked(body['profile'])
            if self.armed and any(not updated[axis]['min'] <= value <= updated[axis]['max']
                                  for values in (self.position, self.target)
                                  for axis, value in zip(('yaw', 'pitch'), values)):
                raise ValueError('Saved limits must include the current and requested position.')
            self.profile = updated
            self.revision = revision(self.profile)
            self.drive_direction = [0, 0]
        elif op == 'arm':
            if set(body) != {'clear', 'commissioning'} or body['clear'] is not True or type(body['commissioning']) is not bool:
                raise ValueError('Confirm the mechanism is clear before enabling control.')
            if self.armed:
                raise ValueError('Control is already enabled.')
            if self.driver.power_flags() != 0:
                raise ValueError('The Pi has recorded power/thermal warnings; inspect before enabling.')
            home = [float(self.profile[axis]['home']) for axis in ('yaw', 'pitch')]
            self.driver.arm(tuple(home))
            self.position = home
            self.command_known = True
            self.target = list(home)
            self.armed = True
            self.commissioning = body['commissioning']
            self.fault = None
            self.last_tick = self.last_heartbeat = self.clock()
            self.drive_direction = [0, 0]
        elif op == 'teaching':
            if set(body) != {'enabled'} or type(body['enabled']) is not bool:
                raise ValueError('Choose whether travel teaching is enabled.')
            if not self.armed or self.clock() - self.last_heartbeat > HEARTBEAT_S:
                raise ValueError('Enable fresh local control before teaching travel.')
            # A mode change never re-arms or jumps to home. Stop at the current command.
            self.drive_direction = [0, 0]
            self.target = list(self.position)
            if not body['enabled'] and any(not self.profile[axis]['min'] <= value <= self.profile[axis]['max']
                                          for axis, value in zip(('yaw', 'pitch'), self.position)):
                raise ValueError('Save this endpoint or move inside the saved range before finishing travel teaching.')
            self.commissioning = body['enabled']
        elif op == 'drive':
            if not self.armed or self.clock() - self.last_heartbeat > HEARTBEAT_S:
                raise ValueError('Enable fresh local control before driving.')
            if set(body) != {'yaw', 'pitch', 'fine'} or type(body['fine']) is not bool or any(
                type(body[a]) is not int or body[a] not in (-1, 0, 1) for a in ('yaw', 'pitch')
            ):
                raise ValueError('Invalid manual direction.')
            self.drive_direction = [body['yaw'], body['pitch']]
            self.drive_fine = body['fine']
            self.drive_until = self.clock() + DRIVE_LEASE_S
            self.target = list(self.position)
        elif op in ('move', 'jog', 'home'):
            if not self.armed:
                raise ValueError('Enable control before moving.')
            if self.clock() - self.last_heartbeat > HEARTBEAT_S:
                self.release('Connection heartbeat expired.')
                raise ValueError('Control heartbeat is stale.')
            if op == 'home':
                target = [self.profile[a]['home'] for a in ('yaw', 'pitch')]
            elif op == 'jog':
                if set(body) != {'axis', 'direction', 'fine'} or body['axis'] not in ('yaw', 'pitch') or type(body['direction']) is not int or body['direction'] not in (-1, 1) or type(body['fine']) is not bool:
                    raise ValueError('Invalid manual jog.')
                target = list(self.target)
                index = ('yaw', 'pitch').index(body['axis'])
                target[index] += body['direction'] * (5 if body['fine'] else 50)
                if not self.commissioning:
                    bounds = self.profile[body['axis']]
                    target[index] = max(bounds['min'], min(bounds['max'], target[index]))
            else:
                if set(body) != {'yaw', 'pitch'} or self.commissioning:
                    raise ValueError('Automatic movement is unavailable during travel setup.')
                target = [body[a] for a in ('yaw', 'pitch')]
                if any(type(v) not in (int, float) or not math.isfinite(v) for v in target):
                    raise ValueError('Invalid movement values.')
                if any(abs(a - b) > 100 for a, b in zip(target, self.target)):
                    raise ValueError('Movement step is too large.')
            checked_positions(target)
            if not self.commissioning:
                for axis, value in zip(('yaw', 'pitch'), target):
                    if not self.profile[axis]['min'] <= value <= self.profile[axis]['max']:
                        raise ValueError(f'{axis.title()} reached its saved travel limit.')
            self.target = [float(v) for v in target]
            self.drive_direction = [0, 0]
        else:
            raise ValueError('Unsupported motion operation.')
        result = {'id': ident, 'ok': True, 'status': self.status()}
        if op not in ('status', 'heartbeat'):
            self.ledger[ident] = (digest, result)
        # Epoch and monotonically unique IDs are transport-owned; keep bounded retry receipts.
        if len(self.ledger) > 8192:
            self.release('Command history filled. Reconnect before continuing.')
            raise ValueError('Command history filled; no commands were discarded or replayed.')
        return result
