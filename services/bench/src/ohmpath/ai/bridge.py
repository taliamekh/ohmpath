"""A narrow MCP surface. The bench service remains the evidence authority.

The bridge receives an already-scoped callback from the bench service. It cannot
create a confirmation or device capability, and its exact tool allowlist is also
enforced on each call rather than only advertised in tools/list.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

MAX_LINE_BYTES = 64 * 1024
MAX_RESULT_BYTES = 32 * 1024
TOOLS = frozenset({"get_session_evidence", "get_circuit_graph", "simulate_variant", "propose_test"})
_SCHEMAS: dict[str, dict[str, str]] = {
    "get_session_evidence": {"session_id": "string", "circuit_revision": "string"},
    "get_circuit_graph": {"session_id": "string", "circuit_revision": "string"},
    "simulate_variant": {"session_id": "string", "circuit_revision": "string", "variant_id": "string"},
    "propose_test": {
        "session_id": "string", "circuit_revision": "string", "quantity": "string",
        "meter_mode": "string", "black_node_id": "string", "red_node_id": "string",
        "reason": "string", "evidence_ids": "array",
    },
}
_QUANTITIES = {"voltage", "resistance", "continuity"}
_METER_MODES = {"DC_voltage", "AC_voltage", "resistance", "continuity"}
_DESCRIPTIONS = {
    "get_session_evidence": "Read recorded bench evidence for one accepted circuit revision. Returns immutable evidence IDs.",
    "get_circuit_graph": "Read the accepted circuit graph, component values, and valid node IDs for one revision.",
    "simulate_variant": "Run a reviewed circuit variant in the real local ngspice simulator and return its evidence ID and numeric result.",
    "propose_test": "Submit a candidate meter test grounded in evidence. This does not request, accept, or confirm a measurement.",
}


class ToolDenied(ValueError):
    pass


class NarrowToolBridge:
    """Dispatch only four query/simulation/proposal operations.

    ``authority`` must use a distinct model-only capability at the bench boundary.
    It must return JSON data with ``session_id`` and ``circuit_revision`` matching
    the request. Simulation results also need an immutable ``simulation_id`` and
    ``input_hash``; evidence reads need nonempty immutable ``evidence_ids``.
    """

    def __init__(self, authority: Callable[[str, dict[str, Any]], dict[str, Any]]):
        self._authority = authority

    def call(self, name: str, arguments: Any) -> dict[str, Any]:
        if name not in TOOLS:
            raise ToolDenied("tool_unavailable")
        required = _SCHEMAS[name]
        if not isinstance(arguments, dict) or set(arguments) != set(required):
            raise ToolDenied("invalid_tool_arguments")
        for key, kind in required.items():
            value = arguments[key]
            if kind == "string" and (not isinstance(value, str) or not value or len(value) > (500 if key == "reason" else 160)):
                raise ToolDenied("invalid_tool_arguments")
            if kind == "array" and (not isinstance(value, list) or not 1 <= len(value) <= 16
                                    or any(not isinstance(item, str) or not item or len(item) > 160 for item in value)):
                raise ToolDenied("invalid_tool_arguments")
        if name == "propose_test":
            if arguments["quantity"] not in _QUANTITIES or arguments["meter_mode"] not in _METER_MODES:
                raise ToolDenied("invalid_tool_arguments")
            expected_modes = {
                "voltage": {"DC_voltage", "AC_voltage"},
                "resistance": {"resistance"},
                "continuity": {"continuity"},
            }
            if arguments["meter_mode"] not in expected_modes[arguments["quantity"]]:
                raise ToolDenied("invalid_tool_arguments")
            if arguments["red_node_id"] == arguments["black_node_id"]:
                raise ToolDenied("invalid_tool_arguments")
        result = self._authority(name, arguments)
        if not isinstance(result, dict):
            raise ToolDenied("invalid_tool_result")
        for key in ("session_id", "circuit_revision"):
            if result.get(key) != arguments[key]:
                raise ToolDenied("stale_tool_result")
        if name == "simulate_variant":
            if result.get("status") != "completed" or not all(
                isinstance(result.get(key), str) and result[key]
                for key in ("simulation_id", "input_hash")
            ):
                raise ToolDenied("invalid_simulation_result")
        if name in ("get_session_evidence", "get_circuit_graph"):
            ids = result.get("evidence_ids")
            if not isinstance(ids, list) or not ids or any(not isinstance(item, str) or not item for item in ids):
                raise ToolDenied("missing_evidence_ids")
        if name == "propose_test":
            if (result.get("status") != "proposed" or not isinstance(result.get("proposal_id"), str)
                    or not result["proposal_id"] or result.get("evidence_ids") != arguments["evidence_ids"]):
                raise ToolDenied("invalid_proposal_result")
        encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_RESULT_BYTES:
            raise ToolDenied("tool_result_too_large")
        return result

    @staticmethod
    def advertised_tools() -> list[dict[str, Any]]:
        return [
            {
                "name": name,
                "description": _DESCRIPTIONS[name],
                "inputSchema": {
                    "type": "object",
                    "properties": {key: {"type": kind} for key, kind in fields.items()},
                    "required": list(fields),
                    "additionalProperties": False,
                },
            }
            for name, fields in _SCHEMAS.items()
        ]

    def handle_mcp(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """Handle one MCP JSON-RPC request; all other methods are rejected."""
        if not isinstance(message, dict) or len(json.dumps(message).encode("utf-8")) > MAX_LINE_BYTES:
            raise ToolDenied("invalid_mcp_message")
        method = message.get("method")
        if method == "notifications/initialized":
            return None
        request_id = message.get("id")
        if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
            raise ToolDenied("invalid_mcp_request_id")
        if method == "initialize":
            version = (message.get("params") or {}).get("protocolVersion")
            if not isinstance(version, str):
                return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "invalid protocol"}}
            return {"jsonrpc": "2.0", "id": request_id, "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "ohmpath-bench-bridge", "version": "0.1.0"},
                "instructions": (
                    "For a circuit recommendation, read the graph and current evidence, run a reviewed "
                    "simulation when useful, then propose a grounded test. Cite immutable evidence IDs. "
                    "These tools cannot confirm measurements or control devices."
                ),
            }}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": self.advertised_tools()}}
        if method == "tools/call":
            params = message.get("params")
            try:
                if not isinstance(params, dict):
                    raise ToolDenied("invalid_tool_arguments")
                value = self.call(params.get("name"), params.get("arguments"))
                return {"jsonrpc": "2.0", "id": request_id, "result": {
                    "content": [{"type": "text", "text": json.dumps(value, separators=(",", ":"))}],
                    "isError": False,
                }}
            except ToolDenied as error:
                return {"jsonrpc": "2.0", "id": request_id, "result": {
                    "content": [{"type": "text", "text": str(error)}], "isError": True,
                }}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method unavailable"}}


class LocalBenchAuthority:
    """Fixed loopback HTTP client using a model-only ephemeral capability."""

    def __init__(self, base_url: str, session_id: str, model_token: str):
        parsed = urlsplit(base_url)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port is None
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ToolDenied("invalid_bench_endpoint")
        if not session_id or len(session_id) > 160 or "/" in session_id or len(model_token) < 32:
            raise ToolDenied("invalid_bench_capability")
        self.session_id = session_id
        self._root = f"http://127.0.0.1:{parsed.port}/v1/sessions/{quote(session_id, safe='')}"
        self._model_root = f"http://127.0.0.1:{parsed.port}/v1/model/sessions/{quote(session_id, safe='')}"
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {model_token}"}, timeout=5, trust_env=False,
            follow_redirects=False,
        )

    def __call__(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if arguments["session_id"] != self.session_id:
            raise ToolDenied("wrong_session")
        revision = arguments["circuit_revision"]
        if name == "get_session_evidence":
            data = self._get("/evidence")
            if not isinstance(data, dict) or data.get("circuit_revision") != revision:
                raise ToolDenied("invalid_bench_result")
            return data
        if name == "get_circuit_graph":
            graph = self._get("/graph")
            if (not isinstance(graph, dict) or not isinstance(graph.get("evidence_ids"), list)
                    or not isinstance(graph.get("graph"), dict)
                    or not isinstance(graph.get("revisions"), dict)
                    or graph["revisions"].get("circuit_revision") != revision):
                raise ToolDenied("stale_tool_result")
            ids = graph["evidence_ids"]
            return {"session_id": self.session_id, "circuit_revision": revision,
                    "evidence_ids": ids[-1:], "graph": graph["graph"]}
        if name == "simulate_variant":
            return self._post("/simulate", {"circuit_revision": revision, "variant_id": arguments["variant_id"]})
        if name == "propose_test":
            body = {key: value for key, value in arguments.items() if key != "session_id"}
            return self._post("/proposals", body)
        raise ToolDenied("tool_unavailable")

    def _get(self, suffix: str) -> Any:
        return self._request("GET", self._root + suffix)

    def _post(self, suffix: str, body: dict[str, Any]) -> dict[str, Any]:
        value = self._request("POST", self._model_root + suffix, json=body)
        if not isinstance(value, dict):
            raise ToolDenied("invalid_bench_result")
        return value

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, url, **kwargs)
            if response.status_code != 200 or len(response.content) > MAX_RESULT_BYTES:
                raise ToolDenied("bench_tool_unavailable")
            return response.json()
        except ToolDenied:
            raise
        except (httpx.HTTPError, ValueError) as error:
            raise ToolDenied("bench_tool_unavailable") from error


def serve_stdio() -> None:
    """MCP subprocess entrypoint. Secrets travel in environment, never argv/logs."""
    authority = LocalBenchAuthority(
        os.environ.get("OHMPATH_MCP_BASE_URL", ""),
        os.environ.get("OHMPATH_MCP_SESSION_ID", ""),
        os.environ.get("OHMPATH_MCP_MODEL_TOKEN", ""),
    )
    bridge = NarrowToolBridge(authority)
    for line in sys.stdin.buffer:
        if len(line) > MAX_LINE_BYTES:
            break
        try:
            request = json.loads(line)
            response = bridge.handle_mcp(request)
        except (ValueError, ToolDenied):
            break
        if response is not None:
            wire = json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n"
            if len(wire) > MAX_LINE_BYTES:
                break
            sys.stdout.buffer.write(wire)
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    serve_stdio()
