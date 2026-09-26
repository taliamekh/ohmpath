"""Explicit local text reports with evidence types kept separate."""

from __future__ import annotations

from html import escape
from .store import SessionStore, utc_now


def _text(value):
    return escape(str(value), quote=False).replace("\r", " ").replace("\n", " ").replace("|", "\\|").replace("`", "'")


def session_report(store: SessionStore, sid: str) -> str:
    state = store.get(sid)
    revision = state["revisions"]["circuit_revision"]
    rows = store.recent_events(sid, 500)
    readings = store.current_measurements(sid, revision)
    current = [e for e in rows if e["circuit_revision"] == revision]
    lines = [f"# Ohm Path — {_text(state['name'])}", "", f"Exported: {utc_now()}",
             f"Session: {sid}", f"Circuit revision: {revision}",
             f"Firmware revision: {state['revisions']['firmware_revision'] or 'unknown'}",
             f"Calibration revision: {state['revisions']['calibration_revision'] or 'unknown'}",
             f"Mode: {'practice (simulated user inputs)' if state['mode'] == 'mock' else 'manual supervised (user-reported inputs)'}",
             "", "Physical verification: pending. This report does not certify hardware, wiring, calibration or safety interlocks.",
             "", "## Latest recorded readings by probe endpoints", "",
             "Only confirmed, non-superseded records for this circuit revision appear below. Their recorded setup may differ from the current setup.", "",
             "| Red / black | Reading | Evidence type | Meter mode | Evidence ID |",
             "| --- | --- | --- | --- | --- |"]
    for event in readings:
        payload = event["payload"]
        candidate, request = payload["candidate"], payload["request"]
        value = f"{candidate['value']} {candidate['si_unit']}" if candidate["value"] is not None else candidate["display_state"]
        lines.append("| " + " | ".join(_text(v) for v in (
            f"{request['red_node_id']} / {request['black_node_id']}", value, payload["evidence_kind"],
            request["meter_mode"], event["event_id"])) + " |")
    if not readings:
        lines.append("| — | No confirmed readings | — | — | — |")
    solves = [e for e in current if e["event_type"] == "simulation.finished"]
    lines.extend(["", "## Local simulation", ""])
    if solves:
        latest = solves[-1]
        result = latest["payload"]
        lines.extend([f"Status: {_text(result['status'])}. Provenance: {_text(result['provenance'])}.",
                      f"Evidence: {latest['event_id']}", f"Netlist SHA-256: {result['netlist_sha256']}",
                      "Simulation predicts the modeled circuit; it does not establish the physical wiring."])
        for node, value in result["node_voltages_v"].items():
            lines.append(f"- {_text(node)}: {value:g} V")
    else:
        lines.append("No local operating-point result appears in the recent evidence window.")
    diagnoses = [e for e in current if e["event_type"] == "diagnosis.compared"]
    lines.extend(["", "## Diagnostic comparison", ""])
    if diagnoses:
        diagnosis = diagnoses[-1]
        lines.append(f"Evidence: {diagnosis['event_id']}. Scores are heuristic rankings, not probabilities.")
        for hypothesis in diagnosis["payload"]["hypotheses"]:
            lines.append(f"- {_text(hypothesis['title'])}: {_text(hypothesis['status'])}")
        for limitation in diagnosis["payload"]["limitations"]:
            lines.append(f"- Limitation: {_text(limitation)}")
    else:
        lines.append("No diagnostic comparison appears in the recent evidence window.")
    lines.extend(["", "## Export scope", "", "This local report excludes raw audio, images, firmware log text, account details, tokens and free-form conversations. It includes the latest 500-event summary window and current reading index, not the full ledger. Original and corrected records remain in the local session database.", ""])
    return "\n".join(lines)
