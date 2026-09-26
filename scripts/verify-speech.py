"""Verify local speech transcription with private synthetic SAPI WAV files.

Run from the repository root with `.venv/Scripts/python.exe scripts/verify-speech.py`.
No microphone, speaker, camera, cloud service, or paid API is used. This is a
synthetic speech check, never evidence of a physical meter reading.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/bench/src"))

from ohmpath.voice.parsing import parse_reading, route_utterance  # noqa: E402
from ohmpath.voice.transcription import WhisperWorker  # noqa: E402

CORPUS = ROOT / "fixtures/voice/synthetic-speech-corpus.json"
RUNTIME = ROOT / "runtime/speech-verification"
REPORT = RUNTIME / "latest-report.json"

_SAPI_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)
$corpus = Get-Content -LiteralPath $env:OHMPATH_SYNTH_CORPUS -Raw | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speaker.SelectVoice($env:OHMPATH_SYNTH_VOICE)
    foreach ($item in $corpus.cases) {
        $path = Join-Path $env:OHMPATH_SYNTH_OUT ($item.id + '.wav')
        $speaker.SetOutputToWaveFile($path, $format)
        $speaker.Speak([string]$item.phrase)
        $speaker.SetOutputToNull()
    }
} finally {
    $speaker.Dispose()
}
"""


def load_corpus() -> dict:
    payload = json.loads(CORPUS.read_text(encoding="utf-8"))
    cases = payload.get("cases")
    if not isinstance(cases, list) or not 12 <= len(cases) <= 20:
        raise ValueError("speech corpus must have 12 to 20 cases")
    seen: set[str] = set()
    for case in cases:
        case_id, phrase = case.get("id"), case.get("phrase")
        if (not isinstance(case_id, str) or not re.fullmatch(r"[a-z0-9_]{1,40}", case_id)
                or case_id in seen or not isinstance(phrase, str) or not 1 <= len(phrase) <= 120):
            raise ValueError("invalid synthetic speech case")
        seen.add(case_id)
        source_route = route_utterance(phrase)
        if source_route != case.get("expected_route"):
            raise ValueError(f"source route mismatch in corpus case {case_id}")
        required_terms = case.get("required_terms", [])
        if (not isinstance(required_terms, list) or any(
                not isinstance(term, str) or not term or term.casefold() not in phrase.casefold()
                for term in required_terms)):
            raise ValueError(f"invalid required terms in corpus case {case_id}")
        if source_route == "reading":
            parsed = parse_reading(phrase, "synthetic-source", meter_mode=case["meter_mode"])
            if "expected_value" in case and parsed.value != case["expected_value"]:
                raise ValueError(f"source value mismatch in corpus case {case_id}")
            if "expected_display_state" in case and parsed.display_state != case["expected_display_state"]:
                raise ValueError(f"source display mismatch in corpus case {case_id}")
    return payload


def contains_required_term(text: str, term: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, re.IGNORECASE) is not None


def synthesize(corpus: dict, output_dir: Path) -> None:
    env = os.environ.copy()
    env.update(OHMPATH_SYNTH_CORPUS=str(CORPUS), OHMPATH_SYNTH_OUT=str(output_dir),
               OHMPATH_SYNTH_VOICE=corpus["voice"])
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _SAPI_SCRIPT],
        capture_output=True, text=True, timeout=120, env=env, shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError("Windows SAPI synthetic WAV generation failed")
    for case in corpus["cases"]:
        path = output_dir / f"{case['id']}.wav"
        if not path.is_file() or path.stat().st_size > 1_500_000:
            raise RuntimeError("synthetic WAV missing or too large")
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                raise RuntimeError("synthetic WAV format is not mono 16-bit 16 kHz")


def verify() -> dict:
    corpus = load_corpus()
    RUNTIME.mkdir(parents=True, exist_ok=True)
    worker = WhisperWorker()
    status = worker.status()
    if status["status"] == "not_installed":
        raise RuntimeError("local Whisper executable or model is unavailable")
    cases: list[dict] = []
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="sapi-", dir=RUNTIME) as temporary:
        output_dir = Path(temporary)
        os.chmod(output_dir, 0o700)
        synthesize(corpus, output_dir)
        try:
            for case in corpus["cases"]:
                wav = (output_dir / f"{case['id']}.wav").read_bytes()
                item = {"id": case["id"], "source_phrase": case["phrase"],
                        "expected_route": case["expected_route"],
                        "expected_value": case.get("expected_value"),
                        "expected_display_state": case.get("expected_display_state"),
                        "required_terms": case.get("required_terms", [])}
                case_started = time.monotonic()
                try:
                    observed = worker.transcribe(wav)
                    transcript = observed["text"]
                    routed = route_utterance(transcript)
                    parsed = parse_reading(transcript, case["id"], meter_mode=case["meter_mode"])
                    route_ok = routed == case["expected_route"]
                    value_ok = ("expected_value" not in case or
                                (parsed.value is not None and Decimal(parsed.value) == Decimal(case["expected_value"])))
                    state_ok = ("expected_display_state" not in case or
                                parsed.display_state == case["expected_display_state"])
                    semantic_ok = all(contains_required_term(transcript, term)
                                      for term in case.get("required_terms", []))
                    item.update(transcript=transcript, transcription_status=observed["status"],
                                route=routed, parsed_value=parsed.value,
                                parsed_display_state=parsed.display_state,
                                parser_ambiguities=parsed.ambiguities,
                                semantic_terms_ok=semantic_ok,
                                passed=observed["status"] == "final" and route_ok and value_ok and state_ok
                                and semantic_ok)
                except Exception as error:
                    # Retain the failure as a named result; never fabricate a transcript.
                    item.update(transcript=None, transcription_status="error", route=None,
                                parsed_value=None, parsed_display_state=None,
                                parser_ambiguities=[], passed=False,
                                error_type=type(error).__name__)
                item["elapsed_seconds"] = round(time.monotonic() - case_started, 3)
                cases.append(item)
                print(json.dumps({key: item[key] for key in (
                    "id", "transcript", "transcription_status", "route", "parsed_value",
                    "parsed_display_state", "passed", "elapsed_seconds")}, ensure_ascii=False))
        finally:
            worker.close()
    report = {"kind": "synthetic_sapi_to_local_whisper", "voice": corpus["voice"],
              "model": status["model"], "worker_provider": status["provider"],
              "local_only": True, "microphone_used": False, "speaker_used": False,
              "physical_measurement": False, "case_count": len(cases),
              "passed_count": sum(bool(case["passed"]) for case in cases),
              "elapsed_seconds": round(time.monotonic() - started, 3), "cases": cases}
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(REPORT), "passed_count": report["passed_count"],
                      "case_count": report["case_count"], "elapsed_seconds": report["elapsed_seconds"]}))
    return report


if __name__ == "__main__":
    result = verify()
    raise SystemExit(0 if result["passed_count"] == result["case_count"] else 1)
