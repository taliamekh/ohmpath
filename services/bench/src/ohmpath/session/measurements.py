from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from ohmpath.contracts import Confirmation, MeasurementCandidate, MeasurementRequest
from ohmpath.session.store import DomainError, SessionStore, digest, opaque_id, validate_contract

UNITS = {"V": ("V", Decimal(1)), "mV": ("V", Decimal("0.001")),
         "uV": ("V", Decimal("0.000001")), "ohm": ("ohm", Decimal(1)),
         "kohm": ("ohm", Decimal(1000)), "Mohm": ("ohm", Decimal(1000000))}


def expiry(seconds=180):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def is_expired(value):
    return datetime.fromisoformat(value) <= datetime.now(timezone.utc)


def context_hash(state, request):
    return digest({"revisions": state["revisions"], "setup": state["setup"],
                   "power_state": state["power_state"], "meter_mode": request["meter_mode"],
                   "meter_range": request["meter_range"], "black": request["black_node_id"],
                   "red": request["red_node_id"], "instrument": request["instrument_id"]})


def cancel_pending(state):
    state.update(active_request=None, pending_candidate=None, confirmation=None)


class Measurements:
    def __init__(self, store: SessionStore):
        self.store = store

    def setup(self, sid, power_state, setup):
        def update(state, emit):
            cancel_pending(state)
            state.update(power_state=power_state, setup=setup, status="active", hardware_state="disarmed")
            state["arming_epoch"] = opaque_id()
            emit("measurement.setup_changed", {"power_state": power_state, "setup": setup})
        return self.store.transact(sid, update)

    def request(self, sid, quantity, meter_mode, red_node_id, black_node_id, meter_range="auto",
                instrument_id="manual-meter", target_ids=None):
        def create(state, emit):
            if state["status"] != "active":
                raise DomainError("session_paused", "Confirm the current setup before resuming.")
            if quantity == "voltage" and meter_mode not in ("DC_voltage", "AC_voltage"):
                raise DomainError("meter_mode_mismatch", "Voltage requires a voltage meter mode.")
            if quantity in ("resistance", "continuity"):
                if meter_mode != quantity:
                    raise DomainError("meter_mode_mismatch", "The meter mode must match the requested quantity.")
                checks = ("power_disconnected", "stored_energy_addressed", "residual_voltage_verified", "path_isolated")
                if state["power_state"] != "off_verified" or not all(state["setup"].get(k) is True for k in checks):
                    raise DomainError("power_prerequisites_missing", "Resistance/continuity requires confirmed isolation checks.")
            elif state["power_state"] != "on_current_limited":
                raise DomainError("power_prerequisites_missing", "Confirm the current-limited low-voltage setup first.")
            if not red_node_id or not black_node_id or red_node_id == black_node_id:
                raise DomainError("probe_endpoints_invalid", "Choose two different, known probe endpoints.")
            # Initial curated fixture nodes. Imported graph integration extends this set.
            nodes = state.get("known_nodes", ["VIN", "MID", "0"])
            if red_node_id not in nodes or black_node_id not in nodes:
                raise DomainError("probe_endpoints_invalid", "A probe endpoint is not in the accepted circuit graph.")
            req = dict(request_id=opaque_id(), quantity=quantity, meter_mode=meter_mode,
                       meter_range=meter_range, red_node_id=red_node_id, black_node_id=black_node_id,
                       instrument_id=instrument_id, target_ids=target_ids or [],
                       power_state=state["power_state"], permitted_units=["V" if quantity == "voltage" else "ohm"],
                       revisions=state["revisions"].copy(), measurement_context_hash="0" * 64,
                       expires_at=expiry(600), status="active")
            req["measurement_context_hash"] = context_hash(state, req)
            req = MeasurementRequest(**req).model_dump()
            validate_contract("MeasurementRequest", req)
            cancel_pending(state)
            state["active_request"] = req
            emit("measurement.requested", req, correlation_id=req["request_id"])
            return req
        return self.store.transact(sid, create)

    def active(self, state):
        req = state["active_request"]
        if req is None or is_expired(req["expires_at"]):
            raise DomainError("measurement_request_expired", "Choose a fresh measurement test.")
        if req["revisions"] != state["revisions"] or req["measurement_context_hash"] != context_hash(state, req):
            raise DomainError("measurement_context_changed", "The setup changed; repeat the instructions and reading.")
        return req

    def typed_candidate(self, sid, text, request_id):
        if len(text) > 4096:
            raise DomainError("measurement_candidate_invalid", "Reading text exceeds 4096 characters.", 422)
        def capture(state, emit):
            req = self.active(state)
            if req["request_id"] != request_id:
                raise DomainError("measurement_context_changed", "This reading belongs to an obsolete test.")
            value, unit, original_number, original_unit = None, None, None, None
            display, ambiguities = "unknown", []
            match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(V|mV|uV|ohm|kohm|Mohm)\s*", text)
            if match:
                original_number, original_unit = match.groups()
                unit, scale = UNITS[original_unit]
                number = Decimal(original_number) * scale
                value, display = str(number), "numeric"
                if unit not in req["permitted_units"]:
                    ambiguities.append("The unit does not match this meter test.")
            elif text.strip().upper() in ("OL", "OVER LIMIT"):
                display, unit = "over_limit", req["permitted_units"][0]
            elif text.strip().lower() in ("unstable", "unknown"):
                display = text.strip().lower()
                ambiguities.append("Re-read a stable display or record a separate observation.")
            else:
                ambiguities.append("Enter a signed number and explicit unit, such as -12.5 mV, or OL.")
            candidate = MeasurementCandidate(candidate_id=opaque_id(), request_id=req["request_id"],
                original_text=text, value=value, si_unit=unit, original_unit=original_unit,
                original_number=original_number, display_state=display, source="typed", ambiguities=ambiguities)
            return self._capture(state, emit, req, candidate)
        return self.store.transact(sid, capture)

    def _capture(self, state, emit, req, candidate):
        validate_contract("MeasurementCandidate", candidate.model_dump())
        if candidate.display_state == "over_limit" and candidate.si_unit is None:
            candidate = candidate.model_copy(update={"si_unit": req["permitted_units"][0]})
        state["pending_candidate"] = candidate.model_dump()
        state["confirmation"] = None
        emit("measurement.candidate", candidate.model_dump(), correlation_id=req["request_id"])
        if not candidate.ambiguities and candidate.display_state in ("numeric", "over_limit"):
            reading = f"{candidate.value} {candidate.si_unit}" if candidate.value is not None else "over limit (OL)"
            prefix = "Practice input. " if state["mode"] == "mock" else ""
            text = f"{prefix}{reading}; {req['meter_mode']}; red at {req['red_node_id']}, black at {req['black_node_id']}."
            state["confirmation"] = Confirmation(confirmation_id=opaque_id(), candidate_id=candidate.candidate_id,
                request_id=req["request_id"], measurement_context_hash=req["measurement_context_hash"],
                revisions=state["revisions"], readback_text=text, readback_completed=False,
                expires_at=expiry()).model_dump()
        return {"candidate": state["pending_candidate"], "confirmation": state["confirmation"]}

    def readback(self, sid, confirmation_id):
        def complete(state, emit):
            self.active(state)
            conf = state["confirmation"]
            if conf is None or conf["confirmation_id"] != confirmation_id or is_expired(conf["expires_at"]):
                raise DomainError("confirmation_expired", "This readback is no longer current.")
            conf["readback_completed"] = True
            emit("measurement.readback_completed", {"confirmation_id": confirmation_id})
            return conf
        return self.store.transact(sid, complete)

    def confirm(self, sid, confirmation_id, candidate_id, request_id, measurement_context_hash,
                revisions, supersedes_event_id=None):
        def accept(state, emit):
            req = self.active(state)
            conf, candidate = state["confirmation"], state["pending_candidate"]
            if conf is None or candidate is None or is_expired(conf["expires_at"]):
                raise DomainError("confirmation_expired", "A fresh reading and readback are required.")
            expected = {"confirmation_id": confirmation_id, "candidate_id": candidate_id,
                        "request_id": request_id, "measurement_context_hash": measurement_context_hash,
                        "revisions": revisions}
            if any(conf[k] != v for k, v in expected.items()) or not conf["readback_completed"]:
                raise DomainError("confirmation_mismatch", "Confirm the exact current reading after its readback.")
            if candidate["ambiguities"] or candidate["si_unit"] not in req["permitted_units"]:
                raise DomainError("measurement_ambiguous", "Clarify the reading before confirming it.")
            if candidate["display_state"] == "numeric":
                try:
                    numeric = Decimal(candidate["value"])
                    if not numeric.is_finite():
                        raise InvalidOperation
                except (InvalidOperation, TypeError):
                    raise DomainError("measurement_invalid", "The reading must be a finite signed decimal.") from None
            if supersedes_event_id:
                old = self.store.db.execute("SELECT body FROM events WHERE event_id=? AND session_id=?",
                                            (supersedes_event_id, sid)).fetchone()
                if old is None or json_event_type(old[0]) != "measurement.confirmed":
                    raise DomainError("correction_target_invalid", "Choose an existing confirmed reading to correct.")
            evidence_kind = "simulated_user_input" if state["mode"] == "mock" else "user_reported_physical_measurement"
            event = emit("measurement.confirmed", {"candidate": candidate, "request": req,
                         "evidence_kind": evidence_kind}, source="user", correlation_id=request_id,
                         supersedes_event_id=supersedes_event_id)
            cancel_pending(state)
            # Preserve an abnormal reading; stop rather than substitute a prediction.
            if candidate["si_unit"] == "V" and candidate["value"] is not None and abs(Decimal(candidate["value"])) > 12:
                state.update(status="paused", hardware_state="disarmed", arming_epoch=opaque_id())
                emit("safety.review_required", {"reason": "Reading exceeds the initial 12 V profile."})
            return event
        return self.store.transact(sid, accept)


def json_event_type(value):
    import json
    return json.loads(value)["event_type"]
