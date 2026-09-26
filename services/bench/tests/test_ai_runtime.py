"""Offline replay of the restricted dynamic-tool runtime; no model usage."""

import json
import threading
from types import SimpleNamespace

import pytest

from ohmpath.ai import live_proof, runtime
from ohmpath.ai.bridge import TOOLS
from ohmpath.ai.codex import PINNED_CLI_VERSION
from ohmpath.ai.live_proof import ProofFailure


class FakeAuthority:
    def __init__(self, base_url, sid, token):
        assert base_url == "http://127.0.0.1:8765"
        assert sid == "session-1"
        assert token == "x" * 32

    def __call__(self, name, args):
        result = {"session_id": "session-1", "circuit_revision": "revision-1"}
        if name == "get_circuit_graph":
            return {**result, "evidence_ids": ["graph-e"], "graph": {"nodes": ["GND", "B"]}}
        if name == "get_session_evidence":
            return {**result, "evidence_ids": ["reading-e"], "events": []}
        if name == "simulate_variant":
            return {**result, "status": "completed", "simulation_id": "sim-1",
                    "input_hash": "hash-1", "evidence_ids": ["sim-e"]}
        if name == "propose_test":
            return {**result, "status": "proposed", "proposal_id": "prop-e",
                    "evidence_ids": args["evidence_ids"]}
        raise AssertionError(name)


class FakeProtocol:
    last = None
    answer_refs = ["sim-e"]

    def __init__(self, command, env):
        assert command == ["fake-app-server"]
        assert all(key not in env for key in ("OPENAI_API_KEY", "CODEX_API_KEY",
                                               "AZURE_OPENAI_API_KEY", "OHMPATH_MCP_MODEL_TOKEN",
                                               "OHMPATH_USER_TOKEN", "OHMPATH_MODEL_TOKEN"))
        assert {key.upper() for key in env} <= runtime.CHILD_ENV_ALLOWLIST
        self.sent = []
        self.notifications = []
        self.closed = False
        self.events = [
            {"id": 100, "method": "item/tool/call", "params": {"threadId": "thread-1",
                "turnId": "turn-1", "tool": "get_session_evidence",
                "arguments": {"session_id": "session-1", "circuit_revision": "revision-1"}}},
            {"id": 101, "method": "item/tool/call", "params": {"threadId": "thread-1",
                "turnId": "turn-1", "tool": "get_circuit_graph",
                "arguments": {"session_id": "session-1", "circuit_revision": "revision-1"}}},
            {"id": 102, "method": "item/tool/call", "params": {"threadId": "thread-1",
                "turnId": "turn-1", "tool": "simulate_variant",
                "arguments": {"session_id": "session-1", "circuit_revision": "revision-1",
                              "variant_id": "healthy"}}},
            {"id": 103, "method": "item/tool/call", "params": {"threadId": "thread-1",
                "turnId": "turn-1", "tool": "propose_test",
                "arguments": {"session_id": "session-1", "circuit_revision": "revision-1",
                              "quantity": "voltage", "meter_mode": "DC_voltage", "black_node_id": "GND",
                              "red_node_id": "B", "reason": "Check divider", "evidence_ids": ["sim-e"]}}},
            {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
                "id": "turn-1", "status": "completed", "items": [{"type": "agentMessage",
                    "text": json.dumps({"circuit_revision": "revision-1", "explanation": "Check B to GND",
                                        "evidence_ids": self.answer_refs, "proposed_test_id": "prop-e"})}]}}},
        ]
        FakeProtocol.last = self

    def request(self, method, params=None, timeout=10):
        if method == "initialize":
            return {}
        if method == "config/read":
            return {"config": {}}
        if method == "account/read":
            return {"account": {"type": "chatgpt"}}
        if method == "model/list":
            return {"data": [{"model": "gpt-6-astra", "inputModalities": ["text", "image"],
                              "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}]}
        if method == "account/rateLimits/read":
            return {"ordinaryUsageAllowed": True, "rateLimitsByLimitId": {"codex": {
                "primary": {"usedPercent": 20}, "secondary": {"usedPercent": 25}}}}
        if method == "thread/start":
            assert len(params["dynamicTools"]) == 4
            assert {tool["name"] for tool in params["dynamicTools"]} == TOOLS
            assert params["allowProviderModelFallback"] is False
            assert params["permissions"] == ":read-only"
            return {"model": "gpt-6-astra", "activePermissionProfile": {"id": ":read-only"},
                    "thread": {"id": "thread-1"}}
        if method == "mcpServerStatus/list":
            return {"data": [{"name": "node_repl", "runtimeStatus": "disabled", "tools": {},
                              "resources": [], "resourceTemplates": []}]}
        if method == "turn/start":
            assert params["model"] == "gpt-6-astra" and params["effort"] == "medium"
            prompt = params["input"][0]["text"]
            assert "Write only the user-facing explanation field" in prompt
            assert "exact numbers and units" in prompt
            assert "Do not roleplay" in prompt
            return {"turn": {"id": "turn-1"}}
        raise AssertionError(method)

    def send(self, message):
        self.sent.append(message)

    def receive(self, timeout):
        return self.events.pop(0)

    def close(self):
        self.closed = True


@pytest.fixture
def replay(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-for-billing")
    monkeypatch.setenv("CODEX_API_KEY", "test-key-not-for-billing")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key-not-for-billing")
    monkeypatch.setenv("OHMPATH_MCP_MODEL_TOKEN", "stale-model-token")
    monkeypatch.setenv("OHMPATH_USER_TOKEN", "never-in-child-user")
    monkeypatch.setenv("OHMPATH_MODEL_TOKEN", "never-in-child-model")
    monkeypatch.setattr(runtime, "LocalBenchAuthority", FakeAuthority)
    monkeypatch.setattr(runtime, "Protocol", FakeProtocol)
    monkeypatch.setattr(runtime, "restricted_command", lambda *, bridge_mcp: ["fake-app-server"]
                        if bridge_mcp is False else (_ for _ in ()).throw(AssertionError("MCP must be disabled")))
    monkeypatch.setattr(runtime, "check_configuration", lambda _, *, bridge_mcp: None
                        if bridge_mcp is False else (_ for _ in ()).throw(AssertionError("MCP must be disabled")))


def test_restricted_runtime_dispatches_only_reviewed_tools_and_validates_answer(replay):
    result = runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                       "revision-1", "Where should I measure?")
    assert result["tool_calls"] == ["get_session_evidence", "get_circuit_graph", "simulate_variant", "propose_test"]
    assert result["simulation_evidence_ids"] == ["sim-e"]
    assert result["answer"]["proposed_test_id"] == "prop-e"
    assert FakeProtocol.last.closed


def test_restricted_runtime_rejects_malformed_evidence_and_closes(replay):
    FakeProtocol.answer_refs = [{"bad": "unhashable"}]
    try:
        with pytest.raises(ProofFailure, match="stale_or_unlinked_model_output"):
            runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                      "revision-1", "Where should I measure?")
        assert FakeProtocol.last.closed
    finally:
        FakeProtocol.answer_refs = ["sim-e"]


def test_restricted_runtime_cancel_before_start_avoids_account_or_model(replay):
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(ProofFailure, match="investigation_cancelled"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?", cancel_event=cancelled)


def test_restricted_runtime_denies_unknown_dynamic_tool(replay, monkeypatch):
    class UnknownToolProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events[0]["params"]["tool"] = "confirm_measurement"

    monkeypatch.setattr(runtime, "Protocol", UnknownToolProtocol)
    with pytest.raises(ProofFailure, match="unexpected_server_request"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed
    assert FakeProtocol.last.sent[-1]["error"]["code"] == -32601


def test_restricted_runtime_allows_many_bounded_text_deltas_before_four_tool_loop(replay, monkeypatch):
    class StreamedProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            deltas = [{"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "delta": "one token ",
            }} for _ in range(600)]
            self.events = deltas + self.events

    monkeypatch.setattr(runtime, "Protocol", StreamedProtocol)
    result = runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                       "revision-1", "Where should I measure?")
    assert result["tool_calls"] == ["get_session_evidence", "get_circuit_graph",
                                    "simulate_variant", "propose_test"]
    assert result["answer"]["evidence_ids"] == ["sim-e"]
    assert FakeProtocol.last.closed


def test_restricted_runtime_rejects_excessive_streamed_events(replay, monkeypatch):
    class FloodProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events = [{"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "delta": "x",
            }} for _ in range(6)] + self.events

    monkeypatch.setattr(runtime, "Protocol", FloodProtocol)
    monkeypatch.setattr(runtime, "MAX_STREAM_EVENTS", 5)
    with pytest.raises(ProofFailure, match="turn_stream_limit"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed


def test_restricted_runtime_rejects_excessive_streamed_bytes(replay, monkeypatch):
    class FloodProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events.insert(0, {"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "delta": "x" * 1000,
            }})

    monkeypatch.setattr(runtime, "Protocol", FloodProtocol)
    monkeypatch.setattr(runtime, "MAX_STREAM_BYTES", 500)
    with pytest.raises(ProofFailure, match="turn_stream_limit"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed


def test_restricted_runtime_rejects_overlong_single_event(replay, monkeypatch):
    class LongEventProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events.insert(0, {"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "delta": "x" * 1000,
            }})

    monkeypatch.setattr(runtime, "Protocol", LongEventProtocol)
    monkeypatch.setattr(runtime, "MAX_EVENT_BYTES", 500)
    with pytest.raises(ProofFailure, match="overlong_app_server_event"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed


def test_restricted_runtime_rejects_excessive_tool_calls(replay, monkeypatch):
    monkeypatch.setattr(runtime, "MAX_TOOL_CALLS", 3)
    with pytest.raises(ProofFailure, match="tool_call_limit"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed
    assert FakeProtocol.last.sent[-1]["error"]["code"] == -32601


def test_restricted_runtime_cancels_during_stream(replay, monkeypatch):
    cancelled = threading.Event()

    class CancelProtocol(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events.insert(0, {"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "delta": "x",
            }})

        def receive(self, timeout):
            value = super().receive(timeout)
            cancelled.set()
            return value

        def request(self, method, params=None, timeout=10):
            if method == "turn/interrupt":
                return {}
            return super().request(method, params, timeout)

    monkeypatch.setattr(runtime, "Protocol", CancelProtocol)
    with pytest.raises(ProofFailure, match="investigation_cancelled"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?", cancel_event=cancelled)
    assert FakeProtocol.last.closed


def test_runtime_rejects_enabled_mcp_inventory(replay, monkeypatch):
    class UnexpectedMcp(FakeProtocol):
        def request(self, method, params=None, timeout=10):
            if method == "mcpServerStatus/list":
                return {"data": [{"name": "ohmpath_bench", "runtimeStatus": "ready",
                                  "tools": {"simulate_variant": {}}}]}
            return super().request(method, params, timeout)

    monkeypatch.setattr(runtime, "Protocol", UnexpectedMcp)
    with pytest.raises(ProofFailure, match="unexpected_mcp_server_inventory"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert FakeProtocol.last.closed


def test_runtime_reports_only_forbidden_item_type(replay, monkeypatch):
    class ForbiddenItem(FakeProtocol):
        def __init__(self, command, env):
            super().__init__(command, env)
            self.events.insert(0, {"method": "item/started", "params": {
                "threadId": "thread-1", "turnId": "turn-1",
                "item": {"type": "mcpToolCall", "secret": "must-not-appear"},
            }})

    monkeypatch.setattr(runtime, "Protocol", ForbiddenItem)
    with pytest.raises(ProofFailure, match=r"^disallowed_model_action_observed:mcpToolCall$") as failure:
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")
    assert "must-not-appear" not in str(failure.value)


def test_runtime_rejects_api_key_auth_and_model_reroute(replay, monkeypatch):
    class ApiKeyAccount(FakeProtocol):
        def request(self, method, params=None, timeout=10):
            if method == "account/read":
                return {"account": {"type": "apiKey"}}
            return super().request(method, params, timeout)

    monkeypatch.setattr(runtime, "Protocol", ApiKeyAccount)
    with pytest.raises(ProofFailure, match="not_chatgpt_subscription"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")

    class ReroutedModel(FakeProtocol):
        def request(self, method, params=None, timeout=10):
            if method == "thread/start":
                super().request(method, params, timeout)
                return {"model": "gpt-6-sol", "activePermissionProfile": {"id": ":read-only"},
                        "thread": {"id": "thread-1"}}
            return super().request(method, params, timeout)

    monkeypatch.setattr(runtime, "Protocol", ReroutedModel)
    with pytest.raises(ProofFailure, match="model_or_permission_rerouted"):
        runtime.run_investigation("http://127.0.0.1:8765", "x" * 32, "session-1",
                                  "revision-1", "Where should I measure?")


def test_restricted_config_builds_dynamic_only_and_standalone_mcp_modes(tmp_path, monkeypatch):
    (tmp_path / "config.toml").write_text("[mcp_servers.inherited]\nenabled = true\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setattr(live_proof.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        stdout=PINNED_CLI_VERSION + "\n"))

    dynamic = live_proof.restricted_command(bridge_mcp=False)
    settings = {dynamic[index + 1].split("=", 1)[0]: dynamic[index + 1].split("=", 1)[1]
                for index in range(3, len(dynamic), 2)}
    assert dynamic[:3] == ["codex", "app-server", "--strict-config"]
    assert settings["mcp_servers.inherited.enabled"] == "false"
    assert not any(key.startswith("mcp_servers.ohmpath_bench.") for key in settings)
    assert settings["features.shell_tool"] == "false"
    assert settings["features.browser_use"] == "false"
    assert settings["web_search"] == '"disabled"'
    assert settings["default_permissions"] == '":read-only"'

    standalone = live_proof.restricted_command()
    assert any("mcp_servers.ohmpath_bench.enabled=true" == value for value in standalone)
    assert any("mcp_servers.inherited.enabled=false" == value for value in standalone)


def test_restricted_config_validation_denies_enabled_mcp_in_dynamic_mode():
    features = {name: False for name in ("shell_tool", "unified_exec", "apps", "plugins",
                                          "remote_plugin", "browser_use", "browser_use_external")}
    config = {"features": features, "web_search": "disabled", "default_permissions": ":read-only",
              "mcp_servers": {"inherited": {"enabled": False}}}
    live_proof.check_configuration(config, bridge_mcp=False)
    config["mcp_servers"]["inherited"]["enabled"] = True
    with pytest.raises(ProofFailure, match="effective_config_not_restricted"):
        live_proof.check_configuration(config, bridge_mcp=False)
    config["mcp_servers"]["inherited"]["enabled"] = False
    config["features"]["shell_tool"] = True
    with pytest.raises(ProofFailure, match="effective_config_not_restricted"):
        live_proof.check_configuration(config, bridge_mcp=False)
    config["features"]["shell_tool"] = False
    config["mcp_servers"] = {"ohmpath_bench": {"enabled": True, "required": True,
                              "default_tools_approval_mode": "auto", "enabled_tools": sorted(TOOLS)},
                             "inherited": {"enabled": False}}
    live_proof.check_configuration(config)
    with pytest.raises(ProofFailure, match="effective_config_not_restricted"):
        live_proof.check_configuration(config, bridge_mcp=False)


@pytest.mark.parametrize("bad", [True, float("nan"), float("inf"), float("-inf"), -1, 101, "0"])
def test_subscription_allowance_rejects_invalid_usage_values(bad):
    limits = {"ordinaryUsageAllowed": True, "rateLimitsByLimitId": {"codex": {
        "primary": {"usedPercent": bad}, "secondary": {"usedPercent": 20}}}}
    with pytest.raises(ProofFailure, match="codex_allowance_unavailable"):
        live_proof.remaining_percent(limits)
