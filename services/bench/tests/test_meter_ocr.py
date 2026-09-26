"""Process replay tests only: no local OCR executable was present during build."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import pytest

from ohmpath.vision import ocr


def _png(width: int = 2, height: int = 2) -> bytes:
    def chunk(name: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + name + payload
                + struct.pack(">I", zlib.crc32(name + payload) & 0xffffffff))

    rows = b"".join(b"\x00" + b"\xff" * (width * 3) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def _fake_tesseract(tmp_path: Path) -> Path:
    path = tmp_path / "tesseract.exe"
    path.write_bytes(b"offline replay placeholder, never executed")
    return path


def _replay(monkeypatch, text: bytes):
    calls = []

    class Process:
        returncode = 0

        def __init__(self, args, *, cwd, stdout, stderr, shell, creationflags):
            assert shell is False
            assert args[2:] == ["stdout", "--psm", "7", "--oem", "1", "-l", "eng"]
            assert Path(args[1]).parent == cwd
            stdout.write(text)
            stdout.flush()
            calls.append((args, Path(args[1])))

        def poll(self):
            return 0

    monkeypatch.setattr(ocr.subprocess, "Popen", Process)
    return calls


def test_mocked_ocr_process_yields_provisional_signed_prefix_candidate(monkeypatch, tmp_path: Path) -> None:
    calls = _replay(monkeypatch, b"-0.12 mV\n")
    candidate = ocr.recognize_meter_crop(_png(), "req-1", "DC_voltage", "DC_voltage",
                                         tesseract_path=_fake_tesseract(tmp_path))
    assert candidate.source == "ocr" and candidate.display_state == "numeric"
    assert candidate.value == "-0.00012" and candidate.original_unit == "mV"
    assert not hasattr(candidate, "confirmed")
    assert len(calls) == 1 and not calls[0][1].exists()  # Private crop was removed.


@pytest.mark.parametrize(("raw", "mode", "expected", "state", "value", "ambiguity"), [
    (b"OL\n", "resistance", "resistance", "over_limit", None, None),
    ("1 MΩ\n".encode(), "resistance", "resistance", "numeric", "1000000", None),
    ("1 mΩ\n".encode(), "resistance", "resistance", "unknown", None, "sign_decimal_or_unit_ambiguous"),
    (b"1.2 V\n", "AC_voltage", "DC_voltage", "unknown", None, "meter_mode_changed"),
    (b"1.2? V\n", "DC_voltage", "DC_voltage", "unknown", None, "sign_decimal_or_unit_ambiguous"),
])
def test_mocked_ocr_text_keeps_overload_case_and_mode_uncertainty(
    monkeypatch, tmp_path: Path, raw: bytes, mode: str, expected: str,
    state: str, value: str | None, ambiguity: str | None,
) -> None:
    _replay(monkeypatch, raw)
    candidate = ocr.recognize_meter_crop(_png(), "req-1", mode, expected,
                                         tesseract_path=_fake_tesseract(tmp_path))
    assert candidate.display_state == state and candidate.value == value
    if ambiguity is not None:
        assert ambiguity in candidate.ambiguities


def test_missing_binary_fails_without_creating_a_candidate(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ocr, "_TESSERACT_CANDIDATES", (tmp_path / "missing.exe",))
    with pytest.raises(ocr.OcrUnavailable, match="not installed"):
        ocr.recognize_meter_crop(_png(), "req-1", "DC_voltage", "DC_voltage")


@pytest.mark.parametrize("data", [b"", b"not an image", b"\x89PNG\r\n\x1a\n" + b"0" * 40,
                                       _png(4097, 1), _png(1, 4097)])
def test_invalid_or_oversized_crop_is_rejected_before_process(data: bytes, monkeypatch) -> None:
    monkeypatch.setattr(ocr.subprocess, "Popen", lambda *_, **__: pytest.fail("OCR process should not start"))
    with pytest.raises(ValueError):
        ocr.recognize_meter_crop(data, "req-1", "DC_voltage", "DC_voltage")


def test_unsupported_executable_and_mode_are_rejected(tmp_path: Path) -> None:
    wrong = tmp_path / "cmd.exe"
    wrong.write_bytes(b"placeholder")
    with pytest.raises(ValueError, match="supported active request"):
        ocr.recognize_meter_crop(_png(), "req-1", "unknown", "DC_voltage", tesseract_path=wrong)
    with pytest.raises(ValueError, match="reviewed Tesseract"):
        ocr.recognize_meter_crop(_png(), "req-1", "DC_voltage", "DC_voltage", tesseract_path=wrong)


def test_timeout_kills_child_and_returns_no_candidate(monkeypatch, tmp_path: Path) -> None:
    instances = []

    class Hanging:
        returncode = None

        def __init__(self, *_, **__):
            self.killed = False
            instances.append(self)

        def poll(self):
            return None

        def kill(self):
            self.killed = True

        def wait(self, timeout):
            self.returncode = -1

    monkeypatch.setattr(ocr.subprocess, "Popen", Hanging)
    monkeypatch.setattr(ocr.time, "sleep", lambda _: None)
    with pytest.raises(ocr.OcrFailed, match="time limit"):
        ocr.recognize_meter_crop(_png(), "req-1", "DC_voltage", "DC_voltage",
                                 tesseract_path=_fake_tesseract(tmp_path), timeout_s=0.000001)
    assert instances[0].killed


def test_output_limit_rejects_mocked_excess_text(monkeypatch, tmp_path: Path) -> None:
    _replay(monkeypatch, b"1" * (ocr.MAX_OUTPUT_BYTES + 1))
    with pytest.raises(ocr.OcrFailed, match="output exceeded"):
        ocr.recognize_meter_crop(_png(), "req-1", "DC_voltage", "DC_voltage",
                                 tesseract_path=_fake_tesseract(tmp_path))
