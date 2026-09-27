import io
import wave
from decimal import Decimal

import pytest

from ohmpath.voice.parsing import parse_reading, route_utterance
from ohmpath.voice import transcription as transcription_module
from ohmpath.voice.transcription import WhisperWorker


@pytest.mark.parametrize("number", ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"])
@pytest.mark.parametrize("prefix,scale", [("volts", "1"), ("millivolts", ".001"), ("microvolts", ".000001"), ("ohms", "1"), ("kiloohms", "1000"), ("milliamps", ".001")])
@pytest.mark.parametrize("sign", ["", "minus "])
def test_signed_unit_corpus(number, prefix, scale, sign):
    words = "zero one two three four five six seven eight nine".split()
    result = parse_reading(f"{sign}{number} point five {prefix}", "request")
    expected = (Decimal(words.index(number)) + Decimal(".5")) * Decimal(scale)
    if sign:
        expected = -expected
    assert Decimal(result.value) == expected
    assert result.ambiguities == []
    assert result.source == "voice"


@pytest.mark.parametrize("text", ["", "2", "minus minus two volts", "maybe two volts", "two or three volts", "two hundred point twenty five volts", "why is it two volts?", "one two volts"])
def test_ambiguous_utterances_stay_unconfirmed(text):
    assert parse_reading(text, "request").ambiguities


def test_over_limit_and_modes_are_preserved():
    assert parse_reading("OL", "request").display_state == "over_limit"
    assert parse_reading("one volt AC", "request", meter_mode="DC_voltage").ambiguities
    assert parse_reading("two hundred seventy five millivolts", "request").value == "0.275"
    assert route_utterance("Why is the voltage 2 V?") == "question"
    assert route_utterance("stop") == "stop"
    assert route_utterance("yes") == "confirmation"


def test_observed_synthetic_speech_unit_spacing_stays_explicit():
    assert parse_reading("Two kilo ohms.", "request").value == "2000"
    assert parse_reading("1 meg ohm", "request").value == "1000000"
    assert parse_reading("Overlimit.", "request").display_state == "over_limit"
    assert parse_reading("one milli ohm", "request").value is None


def test_silence_does_not_start_speech_worker():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0" * 32000)
    worker = WhisperWorker()
    assert worker.transcribe(buffer.getvalue())["status"] == "silence"
    assert worker.process is None


@pytest.mark.parametrize(("worker_text", "expected_status"), [
    ("   ", "empty"), ("[BLANK_AUDIO]", "silence"), (" [blank_audio]. ", "silence"),
    ("[BLANK_AUDIO] [BLANK_AUDIO]", "silence"), ("[NO_SPEECH]", "silence"),
    ("(silence)", "silence"), ("[silence]", "silence"),
])
def test_empty_worker_response_is_not_marked_final(monkeypatch, worker_text, expected_status):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x01" * 16000)

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"text": worker_text}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(transcription_module.httpx, "Client", Client)
    worker = WhisperWorker()
    monkeypatch.setattr(worker, "start", lambda: setattr(worker, "url", "http://127.0.0.1/mock"))

    result = worker.transcribe(buffer.getvalue())

    assert result["text"] == ""
    assert result["status"] == expected_status
    assert result["local_only"] is True
