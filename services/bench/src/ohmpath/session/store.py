from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker

from ohmpath.contracts import EventEnvelope

SCHEMA = json.loads(files("ohmpath").joinpath("contract-schema.json").read_text(encoding="utf-8"))
EVENT_VALIDATOR = Draft202012Validator(
    {"$ref": "#/$defs/EventEnvelope", "$defs": SCHEMA["$defs"]}, format_checker=FormatChecker()
)


def validate_contract(name: str, body: dict):
    validator = Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": SCHEMA["$defs"]},
                                    format_checker=FormatChecker())
    errors = list(validator.iter_errors(body))
    if errors:
        code = {"MeasurementCandidate": "measurement_candidate_invalid",
                "MeasurementRequest": "measurement_request_invalid"}.get(name, "invalid_contract")
        raise DomainError(code, f"Invalid {name}: {errors[0].message}", 422)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def opaque_id() -> str:
    return str(uuid4())


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class SessionStore:
    """One serialized SQLite transaction for state plus immutable evidence.

    Session snapshots can change; the event history cannot. No action queue survives
    restart. This service owns sequence numbers; producers never choose them.
    """

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1):
            self.db.close()
            raise RuntimeError("Unsupported database version; do not overwrite existing evidence")
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)")
            self.db.execute("""CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                sequence INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(session_id, sequence))""")
            self.db.execute("PRAGMA user_version=1")
        self.recover()

    def recover(self):
        for session in self.list_sessions():
            def pause(state, emit):
                state.update(status="paused", active_request=None, pending_candidate=None,
                             confirmation=None, hardware_state="disarmed", power_state="unknown",
                             connection_epoch=opaque_id(), arming_epoch=opaque_id())
                state["setup"] = {}
                emit("session.recovered", {"reason": "Fresh setup and camera checks required."})
            self.transact(session["session_id"], pause)

    def create(self, name: str = "Practice bench") -> dict:
        sid = opaque_id()
        state = {"session_id": sid, "name": name, "mode": "mock", "status": "active",
                 "revisions": {"circuit_revision": "circuit-1", "firmware_revision": None,
                               "calibration_revision": None}, "fixture": "divider",
                 "power_state": "unknown", "setup": {}, "active_request": None,
                 "pending_candidate": None, "confirmation": None, "hardware_state": "disarmed",
                 "connection_epoch": opaque_id(), "arming_epoch": opaque_id()}
        with self.lock, self.db:
            self.db.execute("INSERT INTO sessions VALUES (?, ?)", (sid, json.dumps(state)))
            self._append(state, "session.created", {"mode": "mock"})
        return self.get(sid)

    def list_sessions(self) -> list[dict]:
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute("SELECT state FROM sessions ORDER BY rowid DESC")]

    def get(self, sid: str) -> dict:
        with self.lock:
            row = self.db.execute("SELECT state FROM sessions WHERE id=?", (sid,)).fetchone()
        if row is None:
            raise DomainError("session_not_found", "This bench session does not exist.", 404)
        return json.loads(row[0])

    def events(self, sid: str, after: int = 0, limit: int = 500) -> list[dict]:
        self.get(sid)
        with self.lock:
            rows = self.db.execute(
                "SELECT body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                (sid, after, min(limit, 500)),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def _append(self, state, event_type, payload, source="bench", correlation_id=None,
                supersedes_event_id=None):
        sid = state["session_id"]
        seq = self.db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM events WHERE session_id=?",
                              (sid,)).fetchone()[0]
        now = utc_now()
        event = EventEnvelope(schema_version="1.0.0", session_id=sid, event_id=opaque_id(),
                              event_type=event_type, source=source, sequence=seq, occurred_at=now,
                              received_at=now, correlation_id=correlation_id or opaque_id(),
                              **state["revisions"], payload=payload, supersedes_event_id=supersedes_event_id)
        body = event.model_dump()
        EVENT_VALIDATOR.validate(body)
        self.db.execute("INSERT INTO events VALUES (?, ?, ?, ?)", (event.event_id, sid, seq, json.dumps(body)))
        return body

    def transact(self, sid: str, operation: Callable) -> Any:
        with self.lock, self.db:
            state = self.get(sid)
            result = operation(state, lambda kind, payload, **kw: self._append(state, kind, payload, **kw))
            self.db.execute("UPDATE sessions SET state=? WHERE id=?", (json.dumps(state), sid))
            return result if result is not None else state

    def close(self):
        with self.lock:
            self.db.close()
