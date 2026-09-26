"""One authorized, private end-to-end Ohm Path investigator proof.

This is a development gate, not application startup. Run with the explicit flag
once after the coordinator has checked subscription allowance. It creates a
temporary mock bench and never prints capabilities, evidence IDs, or model text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "bench" / "src"))

from ohmpath.ai import runtime as investigator_runtime  # noqa: E402
from ohmpath.ai.codex import EFFORT, MODEL  # noqa: E402
from ohmpath.ai.live_proof import Protocol as BaseProtocol  # noqa: E402
from ohmpath.ai.runtime import run_investigation  # noqa: E402
from ohmpath.api.app import create_app  # noqa: E402

IMAGE = ROOT / "runtime" / "desktop-verified.png"
REPORT = ROOT / "runtime" / "investigator-proof" / "latest-report.json"
REQUIRED_TOOLS = {"get_circuit_graph", "get_session_evidence", "simulate_variant", "propose_test"}
PROTOCOL_COUNTS = {"turn_events": 0, "turn_bytes": 0, "text_deltas": 0,
                   "tool_requests": 0, "item_updates": 0, "turn_completed": 0,
                   "other_events": 0}


class ObservedNotifications(list):
    def __init__(self, record):
        super().__init__()
        self.record = record

    def pop(self, index=-1):
        value = super().pop(index)
        self.record(value)
        return value


class CountingProtocol(BaseProtocol):
    """Count only event metadata during this one proof; preserve protocol behavior."""

    def __init__(self, command, env):
        super().__init__(command, env)
        self.turn_started = False
        self.notifications = ObservedNotifications(self.record_event)

    def request(self, method, params=None, timeout=10):
        result = super().request(method, params, timeout)
        if method == "turn/start":
            self.turn_started = True
        return result

    def receive(self, timeout):
        value = super().receive(timeout)
        self.record_event(value)
        return value

    def record_event(self, value):
        if not self.turn_started or not isinstance(value, dict):
            return
        PROTOCOL_COUNTS["turn_events"] += 1
        PROTOCOL_COUNTS["turn_bytes"] += len(json.dumps(value, separators=(",", ":")).encode("utf-8"))
        method = value.get("method")
        if method == "item/agentMessage/delta":
            PROTOCOL_COUNTS["text_deltas"] += 1
        elif method == "item/tool/call" and "id" in value:
            PROTOCOL_COUNTS["tool_requests"] += 1
        elif method in ("item/started", "item/completed"):
            PROTOCOL_COUNTS["item_updates"] += 1
        elif method == "turn/completed":
            PROTOCOL_COUNTS["turn_completed"] += 1
        else:
            PROTOCOL_COUNTS["other_events"] += 1


def checked(client: httpx.Client, method: str, path: str, **kwargs):
    response = client.request(method, path, **kwargs)
    if response.status_code != 200:
        raise RuntimeError(f"bench_{method.lower()}_{response.status_code}")
    return response.json()


def snapshot_reviewed_image(temporary: Path) -> tuple[Path, int, str]:
    """Freeze the controlled practice PNG and return its private hash."""
    image = IMAGE.resolve(strict=True)
    if image != IMAGE or image.is_symlink():
        raise RuntimeError("reviewed_image_invalid")
    source_image = image.read_bytes()
    if (image.suffix.lower() != ".png" or not 16 <= len(source_image) <= 2_000_000
            or not source_image.startswith(b"\x89PNG\r\n\x1a\n")):
        raise RuntimeError("reviewed_image_invalid")
    snapshot = temporary / "reviewed-practice-image.png"
    snapshot.write_bytes(source_image)
    snapshot_sha256 = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    if snapshot_sha256 != hashlib.sha256(source_image).hexdigest():
        raise RuntimeError("reviewed_image_snapshot_failed")
    return snapshot, len(source_image), snapshot_sha256


def run() -> dict:

    user_token, model_token = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    with tempfile.TemporaryDirectory(prefix="ohmpath-investigator-") as temporary:
        # The UI screenshot can be refreshed by another local task. Freeze the
        # exact reviewed bytes before the turn and pass only this private copy.
        snapshot, image_bytes, snapshot_sha256 = snapshot_reviewed_image(Path(temporary))
        app = create_app(Path(temporary) / "bench", user_token, model_token)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, log_level="critical", access_log=False,
        ))
        worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        worker.start()
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(.05)
        if not server.started:
            raise RuntimeError("loopback_bench_start_failed")
        base = f"http://127.0.0.1:{port}"
        try:
            with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {user_token}"},
                              timeout=10, trust_env=False) as user, httpx.Client(
                base_url=base, headers={"Authorization": f"Bearer {model_token}"},
                timeout=10, trust_env=False,
            ) as model:
                session = checked(user, "POST", "/v1/sessions", json={
                    "name": "Private synthetic divider proof", "mode": "mock",
                })
                sid = session["session_id"]
                revision = session["revisions"]["circuit_revision"]
                graph = checked(user, "GET", f"/v1/sessions/{sid}/graph")
                graph_ids = set(graph["evidence_ids"])
                if not graph_ids or not {"A", "B", "GND"} <= {
                    node for component in graph["graph"]["components"] for node in component["nodes"]
                }:
                    raise RuntimeError("fixture_graph_invalid")
                checked(user, "POST", f"/v1/sessions/{sid}/setup", json={
                    "power_state": "on_current_limited", "setup": {"low_voltage_confirmed": True},
                })
                simulation = checked(user, "POST", f"/v1/sessions/{sid}/simulate")
                if simulation["event_type"] != "simulation.finished" or simulation["payload"]["status"] != "succeeded":
                    raise RuntimeError("baseline_ngspice_failed")
                request = checked(user, "POST", f"/v1/sessions/{sid}/requests", json={
                    "quantity": "voltage", "meter_mode": "DC_voltage", "red_node_id": "B",
                    "black_node_id": "GND",
                })
                capture = checked(user, "POST", f"/v1/sessions/{sid}/candidates", json={
                    "text": "0.275 V", "request_id": request["request_id"],
                })
                candidate, confirmation = capture["candidate"], capture["confirmation"]
                if confirmation is None or candidate["value"] != "0.275" or candidate["si_unit"] != "V":
                    raise RuntimeError("candidate_review_failed")
                readback = checked(user, "POST", f"/v1/sessions/{sid}/readback", json={
                    "confirmation_id": confirmation["confirmation_id"],
                })
                if not readback["readback_completed"] or "Practice input" not in readback["readback_text"]:
                    raise RuntimeError("readback_incomplete")
                confirmed = checked(user, "POST", f"/v1/sessions/{sid}/confirm", json={
                    "confirmation_id": confirmation["confirmation_id"],
                    "candidate_id": candidate["candidate_id"],
                    "request_id": request["request_id"],
                    "measurement_context_hash": request["measurement_context_hash"],
                    "revisions": request["revisions"],
                })
                if (confirmed["event_type"] != "measurement.confirmed"
                        or confirmed["payload"]["evidence_kind"] != "simulated_user_input"):
                    raise RuntimeError("mock_confirmation_invalid")
                measurement_id = confirmed["event_id"]
                evidence = checked(user, "GET", f"/v1/sessions/{sid}/evidence")
                if measurement_id not in evidence["evidence_ids"] or evidence["circuit_revision"] != revision:
                    raise RuntimeError("confirmed_evidence_unavailable")
                model_routes_denied = all(model.post(f"/v1/sessions/{sid}/{route}", json={}).status_code == 403
                                          for route in ("confirm", "pause"))
                if not model_routes_denied:
                    raise RuntimeError("model_user_scope_violation")

                question = (
                    "In this mock practice divider, the current confirmed simulated-user-input reading "
                    "at B relative to GND is 0.275 V. Does that uniquely establish whether R1 or R2 "
                    "is high, or are both possibilities still open? Explain the ambiguity, use the "
                    "accepted circuit and actual local simulation, then propose a DC voltage reading "
                    "at A relative to GND to distinguish them. The attached image is a historical "
                    "illustration of the app only: its -0.0125 V SUPPLY display came from a different "
                    "older practice moment. It is not the current B reading or physical evidence."
                )
                began = time.monotonic()
                original_protocol = investigator_runtime.Protocol
                investigator_runtime.Protocol = CountingProtocol
                try:
                    result = run_investigation(base, model_token, sid, revision, question, image_path=snapshot)
                finally:
                    investigator_runtime.Protocol = original_protocol
                elapsed = round(time.monotonic() - began, 2)
                history = checked(user, "GET", f"/v1/sessions/{sid}/events")

            simulation_ids = {row["event_id"] for row in history if row["event_type"] == "simulation.finished"
                              and row["payload"].get("status") == "succeeded"}
            proposal_rows = [row for row in history if row["event_type"] == "diagnostic.proposed"]
            proposal_ids = {row["event_id"] for row in proposal_rows}
            answer = result["answer"]
            refs = set(answer["evidence_ids"])
            explanation = answer["explanation"]
            ambiguity = bool(re.search(r"\b(?:ambiguous|ambiguity|both|cannot|can't|not unique|neither)\b",
                                       explanation, re.I))
            explains_both = bool(re.search(r"\bR1\b", explanation, re.I)
                                 and re.search(r"\bR2\b", explanation, re.I))
            proposes_a = any(row["event_id"] == answer["proposed_test_id"]
                             and row["payload"].get("red_node_id") == "A"
                             and row["payload"].get("black_node_id") == "GND"
                             and row["payload"].get("quantity") == "voltage"
                             and row["payload"].get("meter_mode") == "DC_voltage"
                             for row in proposal_rows)
            explanation_mentions_a = bool(re.search(r"\bA\b", explanation))
            valid_ids = refs <= graph_ids | simulation_ids | {measurement_id}
            report = {
                "status": "passed" if all((
                    result["requested_model"] == MODEL, result["actual_model"] == MODEL,
                    result["effort"] == EFFORT, REQUIRED_TOOLS <= set(result["tool_calls"]),
                    len(simulation_ids) >= 2, measurement_id in refs, bool(refs & simulation_ids),
                    valid_ids, answer["proposed_test_id"] in proposal_ids, proposes_a,
                    ambiguity, explains_both, explanation_mentions_a, model_routes_denied,
                )) else "failed",
                "requested_model": result["requested_model"], "actual_model": result["actual_model"],
                "effort": result["effort"], "model_tool_calls": result["tool_calls"],
                "actual_ngspice_simulations": len(simulation_ids),
                "mock_readback_confirmed": True,
                "confirmed_reading_cited": measurement_id in refs,
                "simulation_cited": bool(refs & simulation_ids), "all_evidence_ids_valid": valid_ids,
                "proposed_a_to_gnd": proposes_a, "explanation_mentions_a": explanation_mentions_a,
                "r1_r2_ambiguity_explained": ambiguity and explains_both,
                "historical_image_attached": True, "historical_image_bytes": image_bytes,
                "reviewed_image_sha256": snapshot_sha256,
                "model_user_routes_denied": model_routes_denied,
                "elapsed_seconds": elapsed,
            }
            report["protocol_counts"] = dict(PROTOCOL_COUNTS)
            return report
        finally:
            server.should_exit = True
            worker.join(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authorized-live-proof", action="store_true", help="Run the one authorized subscription turn")
    options = parser.parse_args()
    if not options.authorized_live_proof:
        parser.error("explicit --authorized-live-proof is required")
    try:
        report = run()
    except Exception as error:
        # Never persist exception arguments: they could contain protocol data.
        message = str(error)
        forbidden = re.fullmatch(
            r"disallowed_model_action_observed:(commandExecution|fileChange|webSearch|browser|computerUse|mcpToolCall|imageGeneration)",
            message,
        )
        code = message.split(":", 1)[0]
        code = code if re.fullmatch(r"[a-z_0-9]{1,80}", code) else "proof_exception"
        report = {"status": "failed", "error_type": type(error).__name__, "error_code": code,
                  "protocol_counts": dict(PROTOCOL_COUNTS)}
        if forbidden is not None:
            report["forbidden_item_type"] = forbidden.group(1)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items()
                      if key not in ("protocol_counts", "reviewed_image_sha256")}, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
