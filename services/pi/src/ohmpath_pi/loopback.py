from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import time
from typing import Any

from .models import RevisionSnapshot
from .service import MotionCommand, PiControlService


MAX_MESSAGE_BYTES = 8192


class _LoopbackHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(2.0)
        return request, address


def create_loopback_server(
    service: PiControlService,
    *,
    bearer_token: str,
    port: int = 8765,
) -> ThreadingHTTPServer:
    """Construct (but do not start) a loopback-only HTTP server for status/mocked moves."""
    if len(bearer_token) < 32:
        raise ValueError("loopback API requires a per-launch bearer token of at least 32 characters")
    if not 1024 <= port <= 65535:
        raise ValueError("loopback service port is invalid")

    def reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    class Handler(BaseHTTPRequestHandler):
        server_version = "OhmPathPi/0.1"

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path != "/v1/health":
                self._json(404, {"error": "not_found"})
                return
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, f"Bearer {bearer_token}"):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, {
                "service": "ohmpath-pi",
                "mode": "mock",
                "connected": service.connected,
                "connection_epoch": service.connection_epoch,
                "arming_epoch": service.arming_epoch,
                "revisions": ({
                    "circuit_revision": service.current_revisions.circuit_revision,
                    "firmware_revision": service.current_revisions.firmware_revision,
                    "calibration_revision": service.current_revisions.calibration_revision,
                } if service.current_revisions else None),
                "hardware_safety_state": service.hardware_safety_state,
                "physical_emission_enabled": False,
                "driver": "mock",
                "allowed_targets": sorted(service.allowed_targets),
            })

        def do_POST(self) -> None:
            if self.path != "/v1/motion":
                self._json(404, {"error": "not_found"})
                return
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, f"Bearer {bearer_token}"):
                self._json(401, {"error": "unauthorized"})
                return
            try:
                size = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                self._json(400, {"error": "invalid_content_length"})
                return
            if not 0 <= size <= MAX_MESSAGE_BYTES:
                self._json(413, {"error": "message_too_large"})
                return
            try:
                data = json.loads(self.rfile.read(size), object_pairs_hook=reject_duplicate_json_keys)
                if not isinstance(data, dict):
                    raise ValueError("motion request must be a JSON object")
                if set(data) != {"command_id", "yaw_delta_deg", "pitch_delta_deg", "target_id",
                                "ttl_ms", "connection_epoch", "arming_epoch", "revisions"}:
                    raise ValueError("unexpected or missing motion request fields")
                for key in ("command_id", "target_id"):
                    if not isinstance(data[key], str):
                        raise ValueError(f"{key} must be text")
                if type(data["ttl_ms"]) is not int or type(data["connection_epoch"]) is not int or \
                        type(data["arming_epoch"]) is not int:
                    raise ValueError("TTL and epochs must be integer values")
                if isinstance(data["yaw_delta_deg"], bool) or not isinstance(data["yaw_delta_deg"], (int, float)) or \
                        isinstance(data["pitch_delta_deg"], bool) or not isinstance(data["pitch_delta_deg"], (int, float)):
                    raise ValueError("motion deltas must be numeric values")
                ttl_ms = int(data["ttl_ms"])
                if not 1 <= ttl_ms <= 2000:
                    raise ValueError("motion TTL is outside the accepted range")
                if not isinstance(data["revisions"], dict) or set(data["revisions"]) != {
                    "circuit_revision", "firmware_revision", "calibration_revision"
                }:
                    raise ValueError("revisions have unexpected or missing fields")
                revisions = RevisionSnapshot(**data["revisions"])
                now = time.monotonic()
                command = MotionCommand(
                    command_id=str(data["command_id"]),
                    yaw_delta_deg=float(data["yaw_delta_deg"]),
                    pitch_delta_deg=float(data["pitch_delta_deg"]),
                    target_id=str(data["target_id"]),
                    expires_at_monotonic_s=now + ttl_ms / 1000,
                    connection_epoch=int(data["connection_epoch"]),
                    arming_epoch=int(data["arming_epoch"]),
                    revisions=revisions,
                    ttl_ms=ttl_ms,
                )
                ack = service.submit(command, now_monotonic_s=now)
                self._json(200, {
                    "command_id": ack.command_id,
                    "payload_sha256": ack.payload_sha256,
                    "state": ack.state.value,
                    "connection_epoch": ack.connection_epoch,
                    "arming_epoch": ack.arming_epoch,
                    "reason": ack.reason,
                    "physical_emission_enabled": False,
                })
            except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError) as exc:
                self._json(400, {"error": "invalid_request", "detail": str(exc)[:256]})

        def log_message(self, format: str, *args: object) -> None:
            return

    return _LoopbackHTTPServer(("127.0.0.1", port), Handler)
