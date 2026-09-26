"""Offline protocol replay for the subscription adapter; no inference calls."""

import json
from collections import deque

import pytest
import httpx

from ohmpath.ai.bridge import LocalBenchAuthority, NarrowToolBridge, ToolDenied
from ohmpath.ai.codex import (
    AdapterError,
    BoundaryUnverified,
    CodexAdapter,
    IsolationProof,
    ProtocolError,
    PINNED_CLI_VERSION,
)


def response_for(method):
    if method == "initialize":
        return {}
    if method == "account/read":
        return {"account": {"type": "chatgpt", "planType": "plus"}}
    if method == "model/list":
        return {"data": [{"model": "gpt-6-astra", "inputModalities": ["text", "image"],
                          "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}]}
    if method == "account/rateLimits/read":
        return {"ordinaryUsageAllowed": True, "rateLimitsByLimitId": {
            "codex": {"primary": {"usedPercent": 25}, "secondary": {"usedPercent": 30},
                      "rateLimitReachedType": None}}}
    if method == "thread/start":
        return {"model": "gpt-6-astra", "thread": {"id": "thread-a"}}
    if method == "turn/start":
        return {"turn": {"id": "turn-a"}}
    if method == "turn/interrupt":
        return {}
    raise AssertionError(method)


class ReplayTransport:
    def __init__(self, replacements=None):
        self.queue = deque()
        self.sent = []
        self.replacements = replacements or {}

    def send(self, message):
        self.sent.append(message)
        if "id" in message and "method" in message:
            result = self.replacements.get(message["method"], response_for(message["method"]))
            self.queue.append({"id": message["id"], "result": result})

    def receive(self, timeout):
        if not self.queue:
            raise ProtocolError("app_server_timeout")
        return self.queue.popleft()

    def close(self):
        pass


def bridge():
    def authority(name, arguments):
        result = dict(arguments)
        if name == "simulate_variant":
            result.update(status="completed", simulation_id="sim-1", input_hash="hash-1")
        elif name == "propose_test":
            result.update(status="proposed", proposal_id="proposal-1")
        elif name in ("get_session_evidence", "get_circuit_graph"):
            result["evidence_ids"] = ["evidence-1"]
        return result
    return NarrowToolBridge(authority)


def proof():
    return IsolationProof(PINNED_CLI_VERSION, True, True, True, True, True, True, "denial-probe-1")


def adapter(transport=None, *, isolated=True, tool_surface="mcp"):
    transport = transport or ReplayTransport()
    return CodexAdapter(transport, bridge(), isolation_proof=proof() if isolated else None,
                        tool_surface=tool_surface), transport


def test_bridge_denies_confirmation_device_and_extra_arguments():
    b = bridge()
    expected = {"session_id": "s", "circuit_revision": "r"}
    assert len(b.advertised_tools()) == 4
    assert b.call("get_session_evidence", expected)["evidence_ids"] == ["evidence-1"]
    for name in ("confirm_measurement", "arm_laser", "shell", "read_file"):
        with pytest.raises(ToolDenied, match="tool_unavailable"):
            b.call(name, expected)
    with pytest.raises(ToolDenied, match="invalid_tool_arguments"):
        b.call("simulate_variant", {**expected, "variant_id": "v", "command": "echo bad"})
    denied = b.handle_mcp({"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                           "params": {"name": "arm_laser", "arguments": expected}})
    assert denied["result"]["isError"] is True
    assert b.handle_mcp({"jsonrpc": "2.0", "id": 9, "method": "resources/list"})["error"]["code"] == -32601


def test_bridge_rejects_stale_and_unlinked_results():
    args = {"session_id": "s", "circuit_revision": "r"}
    with pytest.raises(ToolDenied, match="stale_tool_result"):
        NarrowToolBridge(lambda *_: {"session_id": "s", "circuit_revision": "old", "evidence_ids": ["e"]}).call(
            "get_session_evidence", args)
    with pytest.raises(ToolDenied, match="missing_evidence_ids"):
        NarrowToolBridge(lambda *_: {**args, "evidence_ids": []}).call("get_session_evidence", args)
    with pytest.raises(ToolDenied, match="invalid_simulation_result"):
        NarrowToolBridge(lambda *_: {**args, "status": "failed"}).call(
            "simulate_variant", {**args, "variant_id": "v"})


def test_proposal_has_no_confirmation_or_device_side_effect():
    b = bridge()
    args = {"session_id": "s", "circuit_revision": "r", "quantity": "voltage",
            "meter_mode": "DC_voltage", "black_node_id": "GND", "red_node_id": "OUT",
            "reason": "Distinguish open branch", "evidence_ids": ["evidence-1"]}
    assert b.call("propose_test", args)["status"] == "proposed"
    with pytest.raises(ToolDenied, match="invalid_tool_arguments"):
        b.call("propose_test", {**args, "meter_mode": "arbitrary"})
    with pytest.raises(ToolDenied, match="invalid_tool_arguments"):
        b.call("propose_test", {**args, "confirm": True})


def test_local_authority_uses_fixed_model_routes_only():
    calls = []
    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == "Bearer " + "t" * 32
        if request.url.path.endswith("/events"):
            return httpx.Response(200, json=[{"event_id": "e1", "event_type": "circuit.selected",
                                              "circuit_revision": "r"}])
        if request.url.path.endswith("/graph"):
            return httpx.Response(200, json={"revisions": {"circuit_revision": "r"}, "graph": {"nodes": []}, "evidence_ids": ["e1"]})
        if request.url.path.endswith("/simulate"):
            return httpx.Response(200, json={"session_id": "s", "circuit_revision": "r", "status": "completed",
                                              "simulation_id": "sim-1", "input_hash": "hash-1", "evidence_ids": ["e2"]})
        if request.url.path.endswith("/proposals"):
            return httpx.Response(200, json={"session_id": "s", "circuit_revision": "r", "status": "proposed",
                                              "proposal_id": "p1", "evidence_ids": ["e1"]})
        raise AssertionError(request.url.path)

    authority = LocalBenchAuthority("http://127.0.0.1:8765", "s", "t" * 32)
    authority._client.close()
    authority._client = httpx.Client(
        transport=httpx.MockTransport(handler), headers={"Authorization": "Bearer " + "t" * 32}
    )
    b = NarrowToolBridge(authority)
    assert b.call("get_circuit_graph", {"session_id": "s", "circuit_revision": "r"})["evidence_ids"] == ["e1"]
    assert b.call("simulate_variant", {"session_id": "s", "circuit_revision": "r", "variant_id": "healthy"})["simulation_id"] == "sim-1"
    assert b.call("propose_test", {"session_id": "s", "circuit_revision": "r", "quantity": "voltage",
                                    "meter_mode": "DC_voltage", "black_node_id": "GND", "red_node_id": "OUT",
                                    "reason": "Distinguish", "evidence_ids": ["e1"]})["proposal_id"] == "p1"
    assert calls == [("GET", "/v1/sessions/s/graph"),
                     ("POST", "/v1/model/sessions/s/simulate"), ("POST", "/v1/model/sessions/s/proposals")]
    with pytest.raises(ToolDenied, match="wrong_session"):
        authority("get_session_evidence", {"session_id": "another", "circuit_revision": "r"})
    with pytest.raises(ToolDenied, match="invalid_bench_endpoint"):
        LocalBenchAuthority("https://example.com", "s", "t" * 32)


def test_model_bridge_reaches_actual_bench_simulator_without_user_authority(tmp_path):
    from fastapi.testclient import TestClient

    from ohmpath.api.app import create_app
    from ohmpath.circuits.simulation import _resolve_simulator

    if _resolve_simulator(None) is None:
        pytest.skip("ngspice not installed on this host")
    user = {"Authorization": "Bearer " + "u" * 32}
    model = {"Authorization": "Bearer " + "m" * 32}
    with TestClient(create_app(tmp_path, "u" * 32, "m" * 32)) as bench:
        created = bench.post("/v1/sessions", headers=user, json={"name": "AI bridge regression"}).json()
        sid = created["session_id"]
        revision = created["revisions"]["circuit_revision"]

        def relay(request):
            response = bench.request(request.method, request.url.raw_path.decode(),
                                     headers=dict(request.headers),
                                     content=request.content)
            return httpx.Response(response.status_code, content=response.content)

        authority = LocalBenchAuthority("http://127.0.0.1:8765", sid, "m" * 32)
        authority._client.close()
        authority._client = httpx.Client(transport=httpx.MockTransport(relay), headers=model)
        tools = NarrowToolBridge(authority)
        graph = tools.call("get_circuit_graph", {"session_id": sid, "circuit_revision": revision})
        assert graph["evidence_ids"]
        simulation = tools.call("simulate_variant", {"session_id": sid, "circuit_revision": revision,
                                                       "variant_id": "healthy"})
        assert simulation["status"] == "completed"
        assert simulation["result"]["provenance"] == "ngspice_actual"
        assert simulation["evidence_ids"]
        proposal = tools.call("propose_test", {"session_id": sid, "circuit_revision": revision,
                                               "quantity": "voltage", "meter_mode": "DC_voltage",
                                               "black_node_id": "GND", "red_node_id": "B",
                                               "reason": "Compare simulated and measured output",
                                               "evidence_ids": simulation["evidence_ids"]})
        assert proposal["status"] == "proposed"
        assert bench.post(f"/v1/sessions/{sid}/confirm", headers=model, json={}).status_code == 403


def test_subscription_model_and_allowance_checks_fail_closed():
    a, _ = adapter()
    assert a.inspect_access().remaining_percent == 70
    cases = [
        ("account/read", {"account": {"type": "apiKey"}}, "subscription_auth_unavailable"),
        ("model/list", {"data": []}, "model_unavailable"),
        ("account/rateLimits/read", {"ordinaryUsageAllowed": False}, "allowance_unavailable"),
        ("account/rateLimits/read", {"rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 95}}}}, None),
    ]
    for method, replacement, error in cases:
        a, _ = adapter(ReplayTransport({method: replacement}))
        if error:
            with pytest.raises(AdapterError, match=error):
                a.inspect_access()
        else:
            assert a.inspect_access().allowance_ok is False


def test_live_thread_blocked_without_isolation_proof(tmp_path):
    a, transport = adapter(isolated=False)
    with pytest.raises(BoundaryUnverified):
        a.start_thread(tmp_path)
    assert all(m.get("method") != "thread/start" for m in transport.sent)


def test_rerouted_model_is_rejected(tmp_path):
    a, _ = adapter(ReplayTransport({"thread/start": {"model": "gpt-6-sol", "thread": {"id": "t"}}}))
    with pytest.raises(AdapterError, match="model_rerouted"):
        a.start_thread(tmp_path)


def test_cancel_interrupts_active_turn_and_blocks_stale_output(tmp_path):
    a, transport = adapter()
    thread = a.start_thread(tmp_path)
    a.start_turn(thread, "Analyze reviewed evidence")
    a.cancel()
    assert any(m.get("method") == "turn/interrupt" for m in transport.sent)
    with pytest.raises(AdapterError, match="no_active_turn"):
        a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})


def test_answer_requires_current_revision_and_linked_evidence(tmp_path):
    for revision, evidence, expected_error in [
        ("r", ["e"], None), ("old", ["e"], "stale_or_unlinked_model_output"),
        ("r", ["invented"], "stale_or_unlinked_model_output"),
    ]:
        a, transport = adapter()
        thread = a.start_thread(tmp_path)
        a.start_turn(thread, "Analyze reviewed evidence")
        answer = json.dumps({"circuit_revision": revision, "explanation": "Check node A.",
                             "evidence_ids": evidence, "proposed_test_id": "test-1"})
        transport.queue.append({"method": "turn/completed", "params": {"threadId": thread,
            "turn": {"id": "turn-a", "status": "completed", "items": [{"type": "agentMessage", "text": answer}]}}})
        if expected_error:
            with pytest.raises(ProtocolError, match=expected_error):
                a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})
        else:
            assert a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"}) == answer
            assert not any(m.get("method") == "turn/interrupt" for m in transport.sent)


def test_disallowed_action_and_unexpected_approval_are_rejected(tmp_path):
    for event in [
        {"method": "item/started", "params": {"threadId": "thread-a", "item": {"type": "commandExecution"}}},
        {"id": 99, "method": "item/permissions/requestApproval", "params": {"threadId": "thread-a"}},
    ]:
        a, transport = adapter()
        a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
        transport.queue.append(event)
        with pytest.raises(AdapterError):
            a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})
        assert any(m.get("method") == "turn/interrupt" for m in transport.sent)


def test_only_bench_mcp_tool_calls_are_accepted(tmp_path):
    a, transport = adapter()
    a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
    transport.queue.append({"method": "item/completed", "params": {"threadId": "thread-a",
        "item": {"type": "mcpToolCall", "server": "ohmpath_bench", "tool": "simulate_variant",
                 "status": "completed"}}})
    answer = json.dumps({"circuit_revision": "r", "explanation": "Measure node A.",
                         "evidence_ids": ["e"], "proposed_test_id": "test-1"})
    transport.queue.append({"method": "turn/completed", "params": {"threadId": "thread-a",
        "turn": {"id": "turn-a", "status": "completed", "items": [
            {"type": "mcpToolCall", "server": "ohmpath_bench", "tool": "simulate_variant", "status": "completed"},
            {"type": "agentMessage", "text": answer}]}}})
    assert a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"}) == answer

    a, transport = adapter()
    a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
    transport.queue.append({"method": "item/started", "params": {"threadId": "thread-a",
        "item": {"type": "mcpToolCall", "server": "other_server", "tool": "simulate_variant"}}})
    with pytest.raises(AdapterError, match="disallowed_model_action"):
        a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})


def test_completed_item_stream_can_supply_final_answer(tmp_path):
    a, transport = adapter()
    a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
    answer = json.dumps({"circuit_revision": "r", "explanation": "Measure node A.",
                         "evidence_ids": ["e"], "proposed_test_id": "test-1"})
    transport.queue.append({"method": "item/completed", "params": {
        "threadId": "thread-a", "turnId": "turn-a", "item": {"type": "agentMessage", "text": answer}}})
    transport.queue.append({"method": "turn/completed", "params": {"threadId": "thread-a",
        "turn": {"id": "turn-a", "status": "completed", "items": []}}})
    assert a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"}) == answer


def test_malformed_overlong_and_stale_turn_events_fail_closed(tmp_path):
    for event, error in [
        ({"method": "turn/completed", "params": {"threadId": "thread-a", "turn": {
            "id": "turn-a", "status": "completed", "items": [{"type": "agentMessage", "text": "not json"}]}}},
         "invalid_model_output"),
        ({"method": "turn/completed", "params": {"threadId": "thread-a", "turn": {
            "id": "turn-a", "status": "completed", "items": [{"type": "agentMessage", "text": "x" * 12001}]}}},
         "invalid_model_output"),
        ({"method": "turn/completed", "params": {"threadId": "thread-a", "turn": {
            "id": "old-turn", "status": "completed", "items": []}}}, "app_server_timeout"),
    ]:
        a, transport = adapter()
        a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
        transport.queue.append(event)
        with pytest.raises(ProtocolError, match=error):
            a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})


def test_experimental_dynamic_tool_fallback_dispatches_only_bench_tools(tmp_path):
    a, transport = adapter(tool_surface="dynamic")
    a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
    start = next(message for message in transport.sent if message.get("method") == "thread/start")
    assert {tool["name"] for tool in start["params"]["dynamicTools"]} == {
        "get_session_evidence", "get_circuit_graph", "simulate_variant", "propose_test"
    }
    transport.queue.append({"id": 98, "method": "item/tool/call", "params": {
        "threadId": "thread-a", "turnId": "turn-a", "callId": "call-1",
        "tool": "simulate_variant", "arguments": {"session_id": "s", "circuit_revision": "r",
                                                    "variant_id": "healthy"}}})
    answer = json.dumps({"circuit_revision": "r", "explanation": "Measure node B.",
                         "evidence_ids": ["e"], "proposed_test_id": "test-1"})
    transport.queue.append({"method": "turn/completed", "params": {"threadId": "thread-a",
        "turn": {"id": "turn-a", "status": "completed", "items": [
            {"type": "dynamicToolCall", "tool": "simulate_variant", "status": "completed", "success": True},
            {"type": "agentMessage", "text": answer}]}}})
    assert a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"}) == answer
    reply = next(message for message in transport.sent if message.get("id") == 98)
    assert reply["result"]["success"] is True
    assert json.loads(reply["result"]["contentItems"][0]["text"])["simulation_id"] == "sim-1"

    a, transport = adapter(tool_surface="dynamic")
    a.start_turn(a.start_thread(tmp_path), "Analyze reviewed evidence")
    transport.queue.append({"id": 99, "method": "item/tool/call", "params": {
        "threadId": "thread-a", "turnId": "turn-a", "callId": "call-2",
        "tool": "confirm_measurement", "arguments": {}}})
    with pytest.raises(AdapterError, match="disallowed_model_action"):
        a.collect(expected_circuit_revision="r", allowed_evidence_ids={"e"})
    assert next(message for message in transport.sent if message.get("id") == 99)["error"]["code"] == -32601
