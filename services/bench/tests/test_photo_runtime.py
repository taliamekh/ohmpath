"""Offline app-server replay for image-only turns. No subscription calls."""

import json
import threading
import time

import pytest
from jsonschema import Draft202012Validator, ValidationError

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


def test_generated_answer_schema_matches_accepted_shape():
    schema = photo_runtime.answer_schema(CONTEXT, REVISION, {IMAGE_ID})
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    validator.validate(model_answer())
    for mutate in (
        lambda v: v.update(context_id="stale"),
        lambda v: v["answer"].update(extra="unexpected"),
        lambda v: v["answer"].update(questions=["x"] * 9),
        lambda v: v["answer"]["annotations"][0].update(image_id="other"),
        lambda v: v["answer"]["annotations"][0].update(x=True),
        lambda v: v["answer"]["annotations"][0].update(y=1.1),
    ):
        value = model_answer()
        mutate(value)
        with pytest.raises(ValidationError):
            validator.validate(value)


class FakeProtocol:
    last = None
    event_override = None
    answer_override = None
    expected_tools = None
    last_prompt = ""

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
            assert [tool["name"] for tool in params["dynamicTools"]] == (self.expected_tools or [])
            assert params["permissions"] == ":read-only"
            assert params["allowProviderModelFallback"] is False
            return {"model": "gpt-6-astra", "activePermissionProfile": {"id": ":read-only"},
                    "thread": {"id": "thread-1"}}
        if method == "mcpServerStatus/list":
            return {"data": [{"name": "node_repl", "runtimeStatus": "disabled", "tools": {},
                              "resources": [], "resourceTemplates": []}]}
        if method == "turn/start":
            assert len(params["input"]) == 3
            assert params["outputSchema"] == photo_runtime.answer_schema(CONTEXT, REVISION, {IMAGE_ID})
            prompt = params["input"][0]["text"]
            FakeProtocol.last_prompt = prompt
            assert "divider" not in prompt and "simulate_variant" not in prompt
            if not self.expected_tools:
                assert "No bench circuit graph" in prompt
            else:
                assert "remember_circuit" in prompt and "conditional SPICE predictions" in prompt
            assert "Write only the user-facing explanation field" in prompt
            assert "exact numbers and units" in prompt
            assert "Do not roleplay" in prompt
            assert "ON, L, TX, and RX labels" in prompt
            assert "A single photo cannot establish blinking or sustained absence" in prompt
            assert "idle TX/RX and an unlit L do not prove a fault" in prompt
            assert "glare, blur, low light, hands, wires, other objects" in prompt
            assert "a practical next_step to uncover it" in prompt
            assert "Keep the whole JSON under 12000 UTF-8 bytes" in prompt
            assert "Use at most 8 annotations" in prompt
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
    FakeProtocol.expected_tools = None
    FakeProtocol.last_prompt = ""
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


def test_runtime_dispatches_only_bounded_reconstruction_tools(replay):
    FakeProtocol.expected_tools = ["remember_circuit", "simulate_circuit"]
    calls = []
    FakeProtocol.event_override = [
        {"id": 41, "method": "item/tool/call", "params": {"threadId": "thread-1", "turnId": "turn-1",
                                                     "tool": "remember_circuit", "arguments": {"candidate": {"parts": []}}}},
        {"id": 42, "method": "item/tool/call", "params": {"threadId": "thread-1", "turnId": "turn-1",
                                                     "tool": "simulate_circuit", "arguments": {"draft_revision": "rev"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [
                {"type": "dynamicToolCall", "tool": "remember_circuit", "status": "completed"},
                {"type": "agentMessage", "text": json.dumps(model_answer())}]}}},
    ]
    def handler(name, arguments):
        calls.append((name, arguments))
        return {"status": "recorded"}
    result = photo_runtime.run_photo_turn(CONTEXT, REVISION, "Which actual circuit is this?",
                                          [(IMAGE_ID, replay)], [], threading.Event(), tool_handler=handler)
    assert result == model_answer()["answer"]
    assert [name for name, _ in calls] == ["remember_circuit", "simulate_circuit"]
    assert [item["id"] for item in FakeProtocol.last.sent if "id" in item] == [41, 42]


def test_runtime_rejects_unknown_tool_even_when_reconstruction_enabled(replay):
    FakeProtocol.expected_tools = ["remember_circuit", "simulate_circuit"]
    FakeProtocol.event_override = [{"id": 42, "method": "item/tool/call", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "tool": "shell", "arguments": {}}}]
    with pytest.raises(ProofFailure, match="unexpected_server_request"):
        photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question", [(IMAGE_ID, replay)], [],
                                     threading.Event(), tool_handler=lambda *_: {})


def test_runtime_uses_zero_tools_and_only_current_images(replay):
    result = photo_runtime.run_photo_turn(CONTEXT, REVISION, "Explain this image",
                                          [(IMAGE_ID, replay)], [], threading.Event())
    assert result == model_answer()["answer"]
    assert FakeProtocol.last.closed


def test_runtime_marks_prior_photo_stale_but_keeps_test_and_report(replay):
    prior = [{"image_revision": "b" * 64, "user_input": "Build a warning light",
              "reported_result": {"text": "0 V at R2", "provenance": "user_reported_unconfirmed"},
              "explanation": "R2 may be disconnected.",
              "ordered_tests": ["Test: measure R2 | If 0 V: inspect supply | If 3 V: inspect load"],
              "unresolved_questions": ["Which rail is ground?"], "limitations": ["Old view is cropped"]}]
    photo_runtime.run_photo_turn(CONTEXT, REVISION, "Here is a closer image",
                                 [(IMAGE_ID, replay)], prior, threading.Event())
    prompt = FakeProtocol.last_prompt
    assert "Build a warning light" in prompt and "0 V at R2" in prompt
    assert "measure R2" in prompt and "earlier image observations are stale" in prompt
    assert "never reuse earlier annotation coordinates" in prompt
    assert "Ask what the user intended" in prompt


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


@pytest.mark.parametrize(("change", "stage"), [
    (lambda value: value.update(image_revision="stale"), None),
    (lambda value: value["answer"].update(annotations=[{
        "image_id": "00000000-0000-4000-8000-000000000003", "x": .5, "y": .5, "label": "wrong"}]),
     "annotation_image"),
    (lambda value: value["answer"].update(annotations=[{
        "image_id": IMAGE_ID, "x": 1.1, "y": .5, "label": "wrong"}]),
     "annotation_coordinates"),
    (lambda value: value["answer"].update(annotations=[{
        "image_id": IMAGE_ID, "x": .5, "y": .5, "label": "x"}] * 9),
     "annotations_shape"),
    (lambda value: value["answer"].update(explanation=""), "explanation_shape"),
])
def test_answer_schema_rejects_stale_unbounded_and_unknown_image(change, stage):
    value = model_answer()
    change(value)
    with pytest.raises(ProofFailure) as failure:
        photo_runtime.validate_answer(json.dumps(value), CONTEXT, REVISION, {IMAGE_ID})
    assert (failure.value.stage if isinstance(failure.value, photo_runtime.PhotoValidationFailure)
            else None) == stage


@pytest.mark.parametrize(("text", "stage"), [
    ("not JSON private-marker", "json_syntax"),
    ('{"context_id":"x","context_id":"y"}', "duplicate_key"),
    ("{}", "envelope_shape"),
    (json.dumps({**model_answer(), "answer": {"explanation": "x"}}), "answer_shape"),
    (json.dumps({**model_answer(), "answer": {**model_answer()["answer"],
                "next_steps": ["secret-marker" * 60]}}), "next_steps_shape"),
])
def test_validation_failure_has_bounded_stage_not_model_text(text, stage):
    with pytest.raises(photo_runtime.PhotoValidationFailure) as failure:
        photo_runtime.validate_answer(text, CONTEXT, REVISION, {IMAGE_ID})
    assert str(failure.value) == "invalid_model_output"
    assert failure.value.stage == stage
    assert "private-marker" not in str(failure.value)
    assert "secret-marker" not in str(failure.value)


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


def test_runtime_cancel_interrupts_blocked_preflight_rpc(replay, monkeypatch):
    entered = threading.Event()
    released = threading.Event()
    cancel = threading.Event()
    calls = []

    class BlockedPreflight(FakeProtocol):
        def request(self, method, params=None, timeout=10):
            calls.append(method)
            if method == "config/read":
                entered.set()
                released.wait(timeout=2)
            return super().request(method, params, timeout)

    monkeypatch.setattr(photo_runtime, "Protocol", BlockedPreflight)
    canceller = threading.Thread(target=lambda: (entered.wait(timeout=1), cancel.set()))
    canceller.start()
    started = time.monotonic()
    try:
        with pytest.raises(ProofFailure, match="photo_cancelled"):
            photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                         [(IMAGE_ID, replay)], [], cancel)
        assert time.monotonic() - started < 1
        assert FakeProtocol.last.closed
        assert calls == ["initialize", "config/read"]
    finally:
        released.set()
        canceller.join(timeout=1)


def test_runtime_deadline_interrupts_blocked_preflight_rpc(replay, monkeypatch):
    released = threading.Event()

    class BlockedPreflight(FakeProtocol):
        def request(self, method, params=None, timeout=10):
            if method == "config/read":
                released.wait(timeout=2)
            return super().request(method, params, timeout)

    monkeypatch.setattr(photo_runtime, "Protocol", BlockedPreflight)
    monkeypatch.setattr(photo_runtime, "MAX_TURN_SECONDS", .15)
    started = time.monotonic()
    try:
        with pytest.raises(ProofFailure, match="turn_timeout"):
            photo_runtime.run_photo_turn(CONTEXT, REVISION, "Question",
                                         [(IMAGE_ID, replay)], [], threading.Event())
        assert time.monotonic() - started < .75
        assert FakeProtocol.last.closed
    finally:
        released.set()
