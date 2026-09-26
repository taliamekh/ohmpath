"""One-shot, explicitly authorized subscription tool-loop proof.

This is a development gate, never part of automatic application startup. It
prints only aggregate protocol evidence. Run once with --authorized-live-proof
after an explicit coordinator allowance check; no reset or API fallback exists.
"""

from __future__ import annotations

import json
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from pathlib import Path
from typing import Any

import httpx
import uvicorn

from ohmpath.ai.bridge import LocalBenchAuthority, NarrowToolBridge, TOOLS, ToolDenied
from ohmpath.ai.codex import EFFORT, MODEL, PINNED_CLI_VERSION


class ProofFailure(RuntimeError):
    pass


class Protocol:
    def __init__(self, command: list[str], env: dict[str, str]):
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=512)
        self.notifications: list[dict[str, Any]] = []
        self.next_id = 1
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        while True:
            line = self.process.stdout.readline(256_001)
            if not line or len(line) > 256_000 or not line.endswith("\n"):
                break
            try:
                value = json.loads(line)
                if not isinstance(value, dict):
                    break
                self.queue.put_nowait(value)
            except (ValueError, queue.Full):
                break

    def send(self, value: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 10) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        message: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = self.receive(max(.01, deadline - time.monotonic()))
            if event.get("id") == request_id:
                if "error" in event or not isinstance(event.get("result"), dict):
                    raise ProofFailure(f"app_server_rpc_failed:{method}")
                return event["result"]
            self.notifications.append(event)
        raise ProofFailure(f"app_server_rpc_timeout:{method}")

    def receive(self, timeout: float) -> dict[str, Any]:
        try:
            event = self.queue.get(timeout=timeout)
        except queue.Empty as error:
            raise ProofFailure("app_server_event_timeout") from error
        if not isinstance(event, dict):
            raise ProofFailure("invalid_app_server_event")
        return event

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()


def restricted_command() -> list[str]:
    cli = subprocess.run(["codex", "--version"], capture_output=True, text=True, timeout=5, check=True)
    if cli.stdout.strip() != PINNED_CLI_VERSION:
        raise ProofFailure("codex_version_mismatch")
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    config_file = codex_home / "config.toml"
    if not config_file.is_file():
        raise ProofFailure("codex_config_unavailable")
    inherited = list((tomllib.loads(config_file.read_text(encoding="utf-8")).get("mcp_servers") or {}).keys())
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in inherited):
        raise ProofFailure("cannot_disable_inherited_mcp")
    settings = {
        "features.shell_tool": "false",
        "features.unified_exec": "false",
        "features.apps": "false",
        "features.plugins": "false",
        "features.remote_plugin": "false",
        "features.browser_use": "false",
        "features.browser_use_external": "false",
        "web_search": '"disabled"',
        "default_permissions": '":read-only"',
        "mcp_servers.ohmpath_bench.command": json.dumps(sys.executable),
        "mcp_servers.ohmpath_bench.args": '["-m","ohmpath.ai.bridge"]',
        "mcp_servers.ohmpath_bench.enabled": "true",
        "mcp_servers.ohmpath_bench.required": "true",
        "mcp_servers.ohmpath_bench.default_tools_approval_mode": '"auto"',
        "mcp_servers.ohmpath_bench.enabled_tools": json.dumps(sorted(TOOLS)),
        "mcp_servers.ohmpath_bench.env_vars": json.dumps([
            "OHMPATH_MCP_BASE_URL", "OHMPATH_MCP_SESSION_ID", "OHMPATH_MCP_MODEL_TOKEN", "PYTHONPATH",
        ]),
    }
    for name in inherited:
        if name == "ohmpath_bench":
            raise ProofFailure("conflicting_inherited_mcp")
        settings[f"mcp_servers.{name}.enabled"] = "false"
    command = ["codex", "app-server", "--strict-config"]
    for key, value in settings.items():
        command.extend(["-c", f"{key}={value}"])
    return command


def check_configuration(config: dict[str, Any]) -> None:
    features = config.get("features") or {}
    disabled = ("shell_tool", "unified_exec", "apps", "plugins", "remote_plugin",
                "browser_use", "browser_use_external")
    servers = config.get("mcp_servers") or {}
    enabled = {name for name, settings in servers.items() if settings.get("enabled") is not False}
    if (any(features.get(name) is not False for name in disabled)
            or config.get("web_search") != "disabled"
            or config.get("default_permissions") != ":read-only"
            or enabled != {"ohmpath_bench"}
            or servers["ohmpath_bench"].get("required") is not True
            or servers["ohmpath_bench"].get("default_tools_approval_mode") != "auto"
            or set(servers["ohmpath_bench"].get("enabled_tools") or []) != TOOLS):
        raise ProofFailure("effective_config_not_restricted")


def remaining_percent(limits: dict[str, Any]) -> float:
    if limits.get("ordinaryUsageAllowed") is False:
        raise ProofFailure("ordinary_subscription_usage_unavailable")
    bucket = (limits.get("rateLimitsByLimitId") or {}).get("codex")
    if not isinstance(bucket, dict) or bucket.get("rateLimitReachedType"):
        raise ProofFailure("codex_allowance_unavailable")
    used = [w["usedPercent"] for w in (bucket.get("primary"), bucket.get("secondary")) if isinstance(w, dict)]
    if not used or any(not isinstance(x, (int, float)) or x < 0 or x > 100 for x in used):
        raise ProofFailure("codex_allowance_unavailable")
    return 100 - max(used)


def sanitized_answer(items: list[dict[str, Any]]) -> str:
    messages = [item.get("text") for item in items if item.get("type") == "agentMessage"]
    value = messages[-1] if messages and isinstance(messages[-1], str) else ""
    value = re.sub(r"https?://\S+", "[url]", value)
    value = re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27,}", "[id]", value, flags=re.I)
    value = re.sub(r"[A-Za-z0-9_-]{32,}", "[long-value]", value)
    return value[:800]


def run() -> dict[str, Any]:
    from ohmpath.api.app import create_app

    user_token = secrets.token_urlsafe(32)
    model_token = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix="ohmpath-live-proof-") as temporary:
        app = create_app(Path(temporary) / "bench", user_token, model_token)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="critical"))
        server_thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        server_thread.start()
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(.05)
        if not server.started:
            raise ProofFailure("bench_start_failed")
        base = f"http://127.0.0.1:{port}"
        protocol = None
        try:
            with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {user_token}"}, timeout=5,
                              trust_env=False) as client:
                created = client.post("/v1/sessions", json={"name": "Synthetic divider proof"})
                created.raise_for_status()
                session = created.json()
                session_id = session["session_id"]
                revision = session["revisions"]["circuit_revision"]
            model_headers = {"Authorization": f"Bearer {model_token}"}
            with httpx.Client(base_url=base, headers=model_headers, timeout=5, trust_env=False) as client:
                user_only_denied = client.post(f"/v1/sessions/{session_id}/pause").status_code == 403
                confirm_denied = client.post(f"/v1/sessions/{session_id}/confirm", json={}).status_code == 403
            bridge = NarrowToolBridge(LocalBenchAuthority(base, session_id, model_token))
            tool_denied = all(bridge.handle_mcp({"jsonrpc": "2.0", "id": index, "method": "tools/call",
                "params": {"name": name, "arguments": {}}})["result"]["isError"]
                for index, name in enumerate(("shell", "read_file", "confirm_measurement", "arm_laser"), 1))
            if not (user_only_denied and confirm_denied and tool_denied):
                raise ProofFailure("capability_denial_failed")
            env = os.environ.copy()
            env.update(OHMPATH_MCP_BASE_URL=base, OHMPATH_MCP_SESSION_ID=session_id,
                       OHMPATH_MCP_MODEL_TOKEN=model_token,
                       PYTHONPATH=str(Path(__file__).resolve().parents[2]))
            for key in list(env):
                if key.upper() in ("OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"):
                    env.pop(key)
            protocol = Protocol(restricted_command(), env)
            protocol.request("initialize", {"clientInfo": {
                "name": "ohmpath_proof", "title": "Ohm Path Proof", "version": "0.1.0",
            }, "capabilities": {"experimentalApi": True}})
            protocol.send({"method": "initialized", "params": {}})
            check_configuration(protocol.request("config/read", {"includeLayers": False})["config"])
            account = protocol.request("account/read", {"refreshToken": False}).get("account")
            if not isinstance(account, dict) or account.get("type") != "chatgpt":
                raise ProofFailure("not_chatgpt_subscription")
            models = protocol.request("model/list", {"limit": 100, "includeHidden": False})["data"]
            astra = next((m for m in models if m.get("model") == MODEL), None)
            if (astra is None or "image" not in astra.get("inputModalities", [])
                    or EFFORT not in [e.get("reasoningEffort") for e in astra.get("supportedReasoningEfforts", [])]):
                raise ProofFailure("astra_capability_unavailable")
            remaining = remaining_percent(protocol.request("account/rateLimits/read"))
            if remaining < 5:
                raise ProofFailure("allowance_below_live_threshold")
            isolated_cwd = Path(temporary) / "model-workspace"
            isolated_cwd.mkdir()
            started = protocol.request("thread/start", {
                "model": MODEL, "allowProviderModelFallback": False, "cwd": str(isolated_cwd),
                "approvalPolicy": "never", "permissions": ":read-only", "ephemeral": True,
                "serviceTier": "default", "serviceName": "ohmpath_proof",
                "dynamicTools": [{"type": "function", "name": tool["name"],
                                  "description": tool["description"], "inputSchema": tool["inputSchema"]}
                                 for tool in bridge.advertised_tools()],
            }, timeout=20)
            if started.get("model") != MODEL or (started.get("activePermissionProfile") or {}).get("id") != ":read-only":
                raise ProofFailure("model_or_permission_rerouted")
            thread_id = started["thread"]["id"]
            inventory = protocol.request("mcpServerStatus/list", {
                "threadId": thread_id, "detail": "toolsAndAuthOnly", "limit": 20,
            }, timeout=20)["data"]
            active = [s for s in inventory if s.get("name") == "ohmpath_bench"]
            if len(active) != 1 or set(active[0].get("tools") or {}) != TOOLS:
                raise ProofFailure("mcp_tool_inventory_mismatch")
            remaining = remaining_percent(protocol.request("account/rateLimits/read"))
            if remaining < 5:
                raise ProofFailure("allowance_below_live_threshold")
            prompt = (
                "Synthetic passive divider fixture only. Use the provided dynamic tools. "
                "Call get_circuit_graph with "
                f"session_id={session_id} and circuit_revision={revision}. Then call "
                "simulate_variant with variant_id=healthy, using the same session and revision. "
                "Use its actual simulation evidence to call propose_test with "
                "quantity=voltage, meter_mode=DC_voltage, black_node_id=GND, red_node_id=B, "
                "and its simulation evidence ID. Respond with ONLY compact JSON keys circuit_revision, "
                "explanation, evidence_ids, proposed_test_id. Cite the simulation evidence ID. "
                "Do not call any other tool."
            )
            turn = protocol.request("turn/start", {"threadId": thread_id, "model": MODEL, "effort": EFFORT,
                "serviceTierForTurn": "default", "approvalPolicy": "never",
                "input": [{"type": "text", "text": prompt}]}, timeout=15)["turn"]
            turn_id = turn["id"]
            events = protocol.notifications
            deadline = time.monotonic() + 90
            completed = None
            streamed_items: list[dict[str, Any]] = []
            called_tools: list[str] = []
            while time.monotonic() < deadline:
                event = events.pop(0) if events else protocol.receive(max(.01, deadline - time.monotonic()))
                if "id" in event and "method" in event:
                    params = event.get("params") or {}
                    if (event["method"] != "item/tool/call" or params.get("threadId") != thread_id
                            or params.get("turnId") != turn_id or params.get("tool") not in TOOLS):
                        protocol.send({"id": event["id"], "error": {"code": -32601, "message": "request denied"}})
                        raise ProofFailure("unexpected_server_request")
                    try:
                        result = bridge.call(params["tool"], params.get("arguments"))
                        response = {"success": True, "contentItems": [{"type": "inputText",
                            "text": json.dumps(result, separators=(",", ":"))}]}
                        called_tools.append(params["tool"])
                    except ToolDenied as error:
                        response = {"success": False, "contentItems": [{"type": "inputText", "text": str(error)}]}
                    protocol.send({"id": event["id"], "result": response})
                    continue
                if event.get("method") == "turn/completed":
                    params = event.get("params") or {}
                    if params.get("threadId") == thread_id and params.get("turn", {}).get("id") == turn_id:
                        completed = params["turn"]
                        break
                if event.get("method") in ("item/started", "item/completed"):
                    item = (event.get("params") or {}).get("item") or {}
                    if item.get("type") in ("commandExecution", "fileChange", "webSearch", "browser", "computerUse"):
                        raise ProofFailure("disallowed_model_action_observed")
                    if event.get("method") == "item/completed" and (event.get("params") or {}).get("turnId") == turn_id:
                        streamed_items.append(item)
            if completed is None:
                protocol.request("turn/interrupt", {"threadId": thread_id}, timeout=3)
                raise ProofFailure("live_turn_timeout")
            if completed.get("status") != "completed":
                raise ProofFailure("live_turn_not_completed")
            items = completed.get("items") or streamed_items
            tool_items = [item for item in items if item.get("type") == "dynamicToolCall"]
            if any(item.get("type") in ("commandExecution", "fileChange", "webSearch", "browser", "computerUse")
                   for item in items) or not {"get_circuit_graph", "simulate_variant", "propose_test"} <= set(called_tools):
                observed = {"item_types": [item.get("type") for item in items][:20],
                            "tool_names": [item.get("tool") for item in tool_items][:20],
                            "tool_statuses": [item.get("status") for item in tool_items][:20],
                            "called_tools": called_tools[:20], "answer": sanitized_answer(items)}
                raise ProofFailure("required_tool_loop_missing:" + json.dumps(observed, sort_keys=True))
            answer_items = [item for item in items if item.get("type") == "agentMessage"]
            if not answer_items:
                raise ProofFailure("missing_answer")
            answer = json.loads(answer_items[-1]["text"])
            with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {user_token}"}, timeout=5,
                              trust_env=False) as client:
                history = client.get(f"/v1/sessions/{session_id}/events").json()
            simulation_ids = {event["event_id"] for event in history
                              if event.get("event_type") == "simulation.finished"
                              and event.get("payload", {}).get("status") == "succeeded"}
            proposal_ids = {event["event_id"] for event in history if event.get("event_type") == "diagnostic.proposed"}
            valid = (answer.get("circuit_revision") == revision
                     and isinstance(answer.get("explanation"), str) and bool(answer["explanation"].strip())
                     and isinstance(answer.get("evidence_ids"), list)
                     and bool(set(answer["evidence_ids"]) & simulation_ids)
                     and answer.get("proposed_test_id") in proposal_ids)
            if not valid:
                raise ProofFailure("answer_not_evidence_linked")
            return {"requested_model": MODEL, "actual_model": started["model"], "effort": EFFORT,
                    "ordinary_usage": True, "tool_calls": called_tools,
                    "simulation_evidence_count": len(simulation_ids),
                    "proposal_count": len(proposal_ids), "answer_linked": True,
                    "user_routes_denied_to_model": user_only_denied and confirm_denied,
                    "unlisted_tools_denied": tool_denied}
        finally:
            if protocol is not None:
                protocol.close()
            server.should_exit = True
            server_thread.join(timeout=3)


if __name__ == "__main__":
    if sys.argv[1:] != ["--authorized-live-proof"]:
        raise SystemExit("Explicit --authorized-live-proof flag required")
    try:
        print(json.dumps(run(), sort_keys=True))
    except ProofFailure as error:
        print(json.dumps({"proof": "failed", "reason": str(error)}))
        raise SystemExit(1) from None
