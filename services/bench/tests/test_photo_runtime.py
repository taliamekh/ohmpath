"""Offline app-server replay for image-only turns. No subscription calls."""

import json
import threading

import pytest

from ohmpath.ai import photo_runtime
from ohmpath.ai.live_proof import ProofFailure


CONTEXT = "00000000-0000-4000-8000-000000000001"
REVISION = "a" * 64
IMAGE_ID = "00000000-0000-4000-8000-000000000002"


def model_answer():
    return {"context_id": CONTEXT, "image_revision": REVISION, "answer": {
        "explanation": "This may be a resistor. A photo cannot verify its value.",
        "observations": ["A striped component is visible."], "questions": [],
        "next_steps": ["Read its marking."], "annotations": [
            {"image_id": IMAGE_ID, "x": .5, "y": .25, "label": "Visible component"}],
        "limitations": ["No meter reading was supplied."]}}


class FakeProtocol:
    last = None
    event_override = None
    answer_override = None

    def __init__(self, command, env):
        assert command == ["fake-app-server"]
        assert "OPENAI_API_KEY" not in env and "OHMPATH_MODEL_TOKEN" not in env
        self.notifications = []
        self.sent = []
        self.closed = False
        answer = self.answer_override if self.answer_override is not None else model_answer()
        item = {"type": "agentMessage", "text": json.dumps(answer)}
        self.events = self.event_override if self.event_override is not None else [
            {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
                "id": "turn-1", "status": "completed", "items": [item]}}}]
        FakeProtocol.last = self

    def request(self, method, params=None, timeout=10):
        if method in ("initialize", "config/read"):
            return {"config": {}} if method == "config/read" else {}
        if method == "account/read":
            return {"account": {"type": "chatgpt"}}
        if method == "model/list":
            return {"data": [{"model": "gpt-6-astra", "inputModalities": ["text", "image"],
                              "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}]}
        if method == "account/rateLimits/read":
            return {"ordinaryUsageAllowed": True, "rateLimitsByLimitId": {"codex": {
                "primary": {"usedPercent": 10}, "secondary": {"usedPercent": 10}}}}
        if method == "thread/start":
            assert params["dynamicTools"] == []
            assert params["permissions"] == ":read-only"
            assert params["allowProviderModelFallback"] is False
            return {"model": "gpt-6-astra", "activePermissionProfile": {"id": ":read-only"},
                    "thread": {"id": "thread-1"}}
        if method == "mcpServerStatus/list":
            return {"data": [{"name": "node_repl", "runtimeStatus": "disabled", "tools": {},
                              "resources": [], "resourceTemplates": []}]}
        if method == "turn/start":
            assert len(params["input"]) == 3
            prompt = params["input"][0]["text"]
            assert "divider" not in prompt and "simulate_variant" not in prompt
            assert "No bench circuit graph" in prompt
            assert "Write only the user-facing explanation field" in prompt
            assert "exact numbers and units" in prompt
            assert "Do not roleplay" in prompt
            assert params["input"][2]["type"] == "localImage"
            return {"turn": {"id": "turn-1"}}
        if method == "turn/interrupt":
            return {}
        raise AssertionError(method)

    def send(self, message):
        self.sent.append(message)

    def receive(self, timeout):
        return self.events.pop(0)

    def close(self):
        self.closed = True


@pytest.fixture
def replay(monkeypatch, tmp_path):
    FakeProtocol.event_override = None
    FakeProtocol.answer_override = None
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-child")
    monkeypatch.setenv("OHMPATH_MODEL_TOKEN", "must-not-reach-child")
    monkeypatch.setattr(photo_runtime, "Protocol", FakeProtocol)
    monkeypatch.setattr(photo_runtime, "restricted_command", lambda *, bridge_mcp: ["fake-app-server"]
                        if bridge_mcp is False else (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(photo_runtime, "check_configuration", lambda _, *, bridge_mcp: None
                        if bridge_mcp is False else (_ for _ in ()).throw(AssertionError()))
    image = tmp_path / "image.png"
    image.write_bytes(b"x" * 32)
    return image


def test_runtime_uses_zero_tools_and_only_current_images(replay):
    result = photo_runtime.run_photo_turn(CONTEXT, REVISION, "Explain this image",
                                          [(IMAGE_ID, replay)], [], threading.Event())
    assert result == model_answer()["answer"]
    assert FakeProtocol.last.closed


def test_runtime_allows_ordinary_user_message_without_treating_it_as_answer(replay):
    answer_item = {"type": "agentMessage", "text": json.dumps(model_answer())}
    user_item = {"type": "userMessage", "content": [{"type": "inputText", "text": "Question"}]}
    FakeProtocol.event_override = [
        {"method": "item/started", "params": {"threadId": "thread-1", "turnId": "turn-1",
                                          "item": user_item}},
        {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1",
                                            "item": user_item}},
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [user_item, answer_item]}}},
    ]
    result = photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                          [(IMAGE_ID, replay)], [], threading.Event())
    assert result == model_answer()["answer"]
    assert FakeProtocol.last.closed


def test_runtime_total_deadline_also_bounds_preflight(replay, monkeypatch):
    monkeypatch.setattr(photo_runtime, "MAX_TURN_SECONDS", 0)
    with pytest.raises(ProofFailure, match="turn_timeout"):
        photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                     [(IMAGE_ID, replay)], [], threading.Event())
    assert FakeProtocol.last.closed


def test_runtime_denies_unexpected_tool_request(replay):
    FakeProtocol.event_override = [{"id": 42, "method": "item/tool/call", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "tool": "shell"}}]
    with pytest.raises(ProofFailure, match="unexpected_server_request"):
        photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                     [(IMAGE_ID, replay)], [], threading.Event())
    assert FakeProtocol.last.sent[-1]["error"]["code"] == -32601
    assert FakeProtocol.last.closed


@pytest.mark.parametrize("change", [
    lambda value: value.update(image_revision="stale"),
    lambda value: value["answer"].update(annotations=[{
        "image_id": "00000000-0000-4000-8000-000000000003", "x": .5, "y": .5, "label": "wrong"}]),
    lambda value: value["answer"].update(annotations=[{
        "image_id": IMAGE_ID, "x": 1.1, "y": .5, "label": "wrong"}]),
    lambda value: value["answer"].update(annotations=[{
        "image_id": IMAGE_ID, "x": .5, "y": .5, "label": "x"}] * 9),
    lambda value: value["answer"].update(explanation=""),
])
def test_answer_schema_rejects_stale_unbounded_and_unknown_image(change):
    value = model_answer()
    change(value)
    with pytest.raises(ProofFailure):
        photo_runtime.validate_answer(json.dumps(value), CONTEXT, REVISION, {IMAGE_ID})


def test_runtime_cancel_before_model_avoids_protocol(replay):
    cancel = threading.Event()
    cancel.set()
    FakeProtocol.last = None
    with pytest.raises(ProofFailure, match="photo_cancelled"):
        photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                     [(IMAGE_ID, replay)], [], cancel)
    assert FakeProtocol.last is None


def test_runtime_rejects_execution_item(replay):
    FakeProtocol.event_override = [{"method": "item/started", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "item": {"type": "commandExecution"}}}]
    with pytest.raises(ProofFailure, match="disallowed_model_action_observed"):
        photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                     [(IMAGE_ID, replay)], [], threading.Event())
    assert FakeProtocol.last.closed
