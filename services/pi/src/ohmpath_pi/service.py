from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import StrEnum
import hashlib
import json
import math
import re
import secrets
import threading
import time
from typing import Protocol

from .models import AxisPair, RevisionSnapshot

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class AckState(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    COMPLETED = "completed"
    FAULT = "fault"
    UNKNOWN = "unknown_outcome"


@dataclass(frozen=True, slots=True)
class MotionCommand:
    command_id: str
    yaw_delta_deg: float
    pitch_delta_deg: float
    target_id: str
    expires_at_monotonic_s: float
    connection_epoch: int
    arming_epoch: int
    revisions: RevisionSnapshot
    ttl_ms: int | None = None

    def __post_init__(self) -> None:
        if not _ID.fullmatch(self.command_id) or not _ID.fullmatch(self.target_id):
            raise ValueError("command ID and semantic target must be bounded identifiers")
        if not math.isfinite(self.yaw_delta_deg) or not math.isfinite(self.pitch_delta_deg):
            raise ValueError("motion values must be finite")
        if not math.isfinite(self.expires_at_monotonic_s):
            raise ValueError("command TTL must be finite")
        if type(self.connection_epoch) is not int or type(self.arming_epoch) is not int or \
                self.connection_epoch < 0 or self.arming_epoch < 0:
            raise ValueError("connection and arming epochs must be non-negative integers")
        if not isinstance(self.revisions, RevisionSnapshot):
            raise ValueError("command requires a validated revision snapshot")
        if self.ttl_ms is not None and (type(self.ttl_ms) is not int or not 1 <= self.ttl_ms <= 30000):
            raise ValueError("ttl_ms must be between 1 and 30000")

    def payload_hash(self) -> str:
        payload = asdict(self)
        # Monotonic clocks differ by host. The absolute local deadline is not part of
        # the retry identity; the wire TTL is stable across an idempotent retry.
        payload.pop("expires_at_monotonic_s", None)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CommandAck:
    command_id: str
    payload_sha256: str
    state: AckState
    connection_epoch: int
    arming_epoch: int
    reason: str | None = None
    physical_emission_enabled: bool = False

    def __post_init__(self) -> None:
        if self.physical_emission_enabled:
            raise ValueError("this build has no laser-enable capability")


class MotorDriver(Protocol):
    def apply_step(self, command_id: str, delta_deg: AxisPair) -> bool | None: ...


class MockMotorDriver:
    """Records dry-run requests only; it has no GPIO, PWM, or device API."""

    def __init__(self) -> None:
        self.steps: list[tuple[str, AxisPair]] = []
        self.unknown_next = False
        self.fail_next = False

    def apply_step(self, command_id: str, delta_deg: AxisPair) -> bool | None:
        if self.unknown_next:
            self.unknown_next = False
            return None
        if self.fail_next:
            self.fail_next = False
            return False
        self.steps.append((command_id, delta_deg))
        return True


class PiControlService:
    """Epoch-checked idempotent receiver. The default and only bundled driver is a mock."""

    def __init__(
        self,
        *,
        driver: MotorDriver | None = None,
        initial_revisions: RevisionSnapshot | None = None,
        allowed_targets: frozenset[str] = frozenset(),
        max_step_deg: float = 2.0,
        max_speed_deg_s: float = 8.0,
        min_yaw_deg: float = -80.0,
        max_yaw_deg: float = 80.0,
        min_pitch_deg: float = -30.0,
        max_pitch_deg: float = 30.0,
        min_step_interval_s: float = 0.15,
        max_ttl_s: float = 2.0,
        heartbeat_timeout_s: float = 1.0,
        ledger_limit: int = 1024,
    ) -> None:
        if any(not math.isfinite(value) or value <= 0 for value in
               (max_step_deg, max_speed_deg_s, min_step_interval_s, max_ttl_s, heartbeat_timeout_s)):
            raise ValueError("service limits must be finite and positive")
        if min_yaw_deg >= max_yaw_deg or min_pitch_deg >= max_pitch_deg:
            raise ValueError("travel bounds are invalid")
        if any(not math.isfinite(value) for value in (min_yaw_deg, max_yaw_deg, min_pitch_deg, max_pitch_deg)):
            raise ValueError("travel bounds must be finite")
        if ledger_limit < 1:
            raise ValueError("ledger limit must be positive")
        if driver is not None and type(driver) is not MockMotorDriver:
            raise ValueError("this build only contains the dry-run mock motor driver")
        self._driver: MotorDriver = driver if driver is not None else MockMotorDriver()
        self.current_revisions = initial_revisions
        if any(not _ID.fullmatch(target) for target in allowed_targets):
            raise ValueError("allowed semantic targets must be bounded identifiers")
        self.allowed_targets = allowed_targets
        self.max_step_deg = max_step_deg
        self.max_speed_deg_s = max_speed_deg_s
        self.min_step_interval_s = min_step_interval_s
        self.yaw_bounds_deg = (min_yaw_deg, max_yaw_deg)
        self.pitch_bounds_deg = (min_pitch_deg, max_pitch_deg)
        self.max_ttl_s = max_ttl_s
        self.heartbeat_timeout_s = heartbeat_timeout_s
        self.ledger_limit = ledger_limit
        # A restarted process must not recreate the epoch values from its prior life.
        self.connection_epoch = secrets.randbits(63) + 1
        self.arming_epoch = secrets.randbits(63) + 1
        self.connected = False
        self.last_heartbeat_monotonic_s: float | None = None
        self.hardware_safety_state = "disarmed"
        self._mock_position_deg: AxisPair = (0.0, 0.0)
        self._last_step_time: float | None = None
        self._commands: dict[str, CommandAck] = {}
        self._unknown: set[str] = set()
        self._lock = threading.Lock()

    @property
    def physical_emission_enabled(self) -> bool:
        return False

    @property
    def driver(self) -> MockMotorDriver:
        # This slice deliberately exposes no pluggable physical motor driver.
        return self._driver  # type: ignore[return-value]

    def link_state(self, connected: bool, *, now_monotonic_s: float | None = None) -> None:
        if connected and (now_monotonic_s is None or not math.isfinite(now_monotonic_s) or now_monotonic_s < 0):
            raise ValueError("a connected state requires a valid local monotonic timestamp")
        with self._lock:
            self.connection_epoch += 1
            self.connected = connected
            self.last_heartbeat_monotonic_s = now_monotonic_s if connected else None
            self.arming_epoch += 1
            self.hardware_safety_state = "disarmed"

    def heartbeat(self, *, now_monotonic_s: float) -> bool:
        if not math.isfinite(now_monotonic_s) or now_monotonic_s < 0:
            return False
        with self._lock:
            if not self.connected:
                return False
            if self.last_heartbeat_monotonic_s is not None and now_monotonic_s <= self.last_heartbeat_monotonic_s:
                return False
            self.last_heartbeat_monotonic_s = now_monotonic_s
            return True

    def watchdog_tick(self, *, now_monotonic_s: float) -> bool:
        if not math.isfinite(now_monotonic_s) or now_monotonic_s < 0:
            with self._lock:
                self.arming_epoch += 1
                self.connected = False
                self.hardware_safety_state = "disarmed"
                self.last_heartbeat_monotonic_s = None
            return True
        with self._lock:
            stale = (not self.connected or self.last_heartbeat_monotonic_s is None or
                     now_monotonic_s < self.last_heartbeat_monotonic_s or
                     now_monotonic_s - self.last_heartbeat_monotonic_s > self.heartbeat_timeout_s)
            if stale:
                self.arming_epoch += 1
                self.connected = False
                self.hardware_safety_state = "disarmed"
                self.last_heartbeat_monotonic_s = None
            return stale

    def disarm(self) -> int:
        with self._lock:
            self.arming_epoch += 1
            self.hardware_safety_state = "disarmed"
            return self.arming_epoch

    def _reject(self, command: MotionCommand, payload_hash: str, reason: str) -> CommandAck:
        return CommandAck(command.command_id, payload_hash, AckState.REJECTED,
                          self.connection_epoch, self.arming_epoch, reason)

    def submit(self, command: MotionCommand, *, now_monotonic_s: float | None = None) -> CommandAck:
        """Process one bounded mock move. Duplicate IDs are never executed twice."""
        now = time.monotonic() if now_monotonic_s is None else now_monotonic_s
        payload_hash = command.payload_hash()
        with self._lock:
            old = self._commands.get(command.command_id)
            if old:
                if old.payload_sha256 != payload_hash:
                    return self._reject(command, payload_hash, "command_id_payload_conflict")
                return old
            if not math.isfinite(now) or now < 0:
                ack = self._reject(command, payload_hash, "invalid_monotonic_time")
                self._remember(ack)
                return ack
            if len(self._commands) >= self.ledger_limit:
                self.connection_epoch += 1
                self.arming_epoch += 1
                self.connected = False
                self.hardware_safety_state = "disarmed"
                self.last_heartbeat_monotonic_s = None
                return self._reject(command, payload_hash, "command_ledger_full_disarmed")
            reason = None
            if not self.connected:
                reason = "device_disconnected"
            elif self.last_heartbeat_monotonic_s is None or not 0 <= now - self.last_heartbeat_monotonic_s <= self.heartbeat_timeout_s:
                reason = "heartbeat_stale_disarmed"
                self.connection_epoch += 1
                self.arming_epoch += 1
                self.connected = False
                self.hardware_safety_state = "disarmed"
                self.last_heartbeat_monotonic_s = None
            elif command.connection_epoch != self.connection_epoch:
                reason = "stale_connection_epoch"
            elif command.arming_epoch != self.arming_epoch:
                reason = "stale_arming_epoch"
            elif command.target_id not in self.allowed_targets:
                reason = "target_not_authorized"
            elif self.current_revisions is None or command.revisions != self.current_revisions:
                reason = "stale_revisions"
            elif command.expires_at_monotonic_s <= now:
                reason = "command_expired"
            elif command.expires_at_monotonic_s - now > self.max_ttl_s:
                reason = "command_ttl_too_long"
            elif abs(command.yaw_delta_deg) > self.max_step_deg or abs(command.pitch_delta_deg) > self.max_step_deg:
                reason = "step_limit_exceeded"
            elif not (self.yaw_bounds_deg[0] <= self._mock_position_deg[0] + command.yaw_delta_deg <= self.yaw_bounds_deg[1]):
                reason = "yaw_travel_limit"
            elif not (self.pitch_bounds_deg[0] <= self._mock_position_deg[1] + command.pitch_delta_deg <= self.pitch_bounds_deg[1]):
                reason = "pitch_travel_limit"
            elif self._last_step_time is not None and max(abs(command.yaw_delta_deg), abs(command.pitch_delta_deg)) > \
                    self.max_speed_deg_s * max(0.0, now - self._last_step_time):
                reason = "speed_limit_exceeded"
            elif self._last_step_time is None and max(abs(command.yaw_delta_deg), abs(command.pitch_delta_deg)) > \
                    self.max_speed_deg_s * self.min_step_interval_s:
                reason = "speed_limit_exceeded"
            if reason is not None:
                ack = self._reject(command, payload_hash, reason)
                self._remember(ack)
                return ack

            result = self._driver.apply_step(command.command_id,
                                             (command.yaw_delta_deg, command.pitch_delta_deg))
            if result is True:
                self._mock_position_deg = (
                    self._mock_position_deg[0] + command.yaw_delta_deg,
                    self._mock_position_deg[1] + command.pitch_delta_deg,
                )
                self._last_step_time = now
                ack = CommandAck(command.command_id, payload_hash, AckState.COMPLETED,
                                 self.connection_epoch, self.arming_epoch)
            elif result is None:
                ack = CommandAck(command.command_id, payload_hash, AckState.UNKNOWN,
                                 self.connection_epoch, self.arming_epoch, "completion_unconfirmed")
                self._unknown.add(command.command_id)
                self.connection_epoch += 1
                self.arming_epoch += 1
                self.connected = False
                self.last_heartbeat_monotonic_s = None
                self.hardware_safety_state = "disarmed"
            else:
                ack = CommandAck(command.command_id, payload_hash, AckState.FAULT,
                                 self.connection_epoch, self.arming_epoch, "mock_driver_fault")
                self.connection_epoch += 1
                self.arming_epoch += 1
                self.connected = False
                self.last_heartbeat_monotonic_s = None
                self.hardware_safety_state = "fault"
            self._remember(ack)
            return ack

    def _remember(self, ack: CommandAck) -> None:
        self._commands[ack.command_id] = ack

    def reconcile_unknown(self, command_id: str, *, outcome_confirmed: bool) -> CommandAck:
        """Resolve an unknown result while disconnected; never retries the movement."""
        with self._lock:
            prior = self._commands.get(command_id)
            if prior is None or command_id not in self._unknown:
                raise ValueError("command has no unknown outcome to reconcile")
            if self.connected or self.hardware_safety_state != "disarmed":
                raise RuntimeError("reconciliation is allowed only while disarmed and disconnected")
            state = AckState.COMPLETED if outcome_confirmed else AckState.FAULT
            ack = CommandAck(command_id, prior.payload_sha256, state,
                             self.connection_epoch, self.arming_epoch,
                             None if outcome_confirmed else "outcome_not_confirmed")
            self._commands[command_id] = ack
            self._unknown.discard(command_id)
            return ack
