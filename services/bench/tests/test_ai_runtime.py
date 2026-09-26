"""Offline replay of the restricted dynamic-tool runtime; no model usage."""

import json
import threading

import pytest

from ohmpath.ai import runtime
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
            assert params["allowProviderModelFallback"] is False
            return {"model": "gpt-6-astra", "activePermissionProfile": {"id": ":read-only"},
                    "thread": {"id": "thread-1"}}
        if method == "mcpServerStatus/list":
            return {"data": [{"name": "ohmpath_bench", "tools": {
                "get_session_evidence": {}, "get_circuit_graph": {},
                "simulate_variant": {}, "propose_test": {}}}]}
        if method == "turn/start":
            assert params["model"] == "gpt-6-astra" and params["effort"] == "medium"
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
    monkeypatch.setattr(runtime, "LocalBenchAuthority", FakeAuthority)
    monkeypatch.setattr(runtime, "Protocol", FakeProtocol)
    monkeypatch.setattr(runtime, "restricted_command", lambda: ["fake-app-server"])
    monkeypatch.setattr(runtime, "check_configuration", lambda _: None)


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
