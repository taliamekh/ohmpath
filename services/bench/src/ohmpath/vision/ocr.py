"""Bounded local OCR for a user-selected meter display crop.

This module returns a provisional MeasurementCandidate. It has no session write,
readback, confirmation, or device capability. The meter mode comes only from
the active user request/configuration, never from optical recognition.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

from ohmpath.contracts import MeasurementCandidate

from .meter import parse_meter_candidate

MAX_IMAGE_BYTES = 2_000_000
MAX_PIXELS = 8_000_000
MAX_SIDE = 4096
MAX_OUTPUT_BYTES = 32_000
MAX_RUN_SECONDS = 8.0
_MODES = frozenset({"DC_voltage", "AC_voltage", "resistance", "continuity"})
_TESSERACT_CANDIDATES = (
    Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tesseract-OCR/tesseract.exe",
    Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs/Tesseract-OCR/tesseract.exe",
    Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Tesseract-OCR/tesseract.exe",
)


class OcrUnavailable(RuntimeError):
    """A reviewed local Tesseract executable is not available."""


class OcrFailed(RuntimeError):
    """A bounded optical recognition run failed; no candidate was created."""


def _dimensions(width: int, height: int) -> None:
    if not 1 <= width <= MAX_SIDE or not 1 <= height <= MAX_SIDE or width * height > MAX_PIXELS:
        raise ValueError("meter crop dimensions exceed supported bounds")


def _image_suffix(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(data) < 33 or data[12:16] != b"IHDR" or int.from_bytes(data[8:12], "big") != 13:
            raise ValueError("invalid meter PNG crop")
        _dimensions(int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        position = 2
        while position + 4 <= len(data):
            if data[position] != 0xff:
                raise ValueError("invalid meter JPEG crop")
            while position < len(data) and data[position] == 0xff:
                position += 1
            if position >= len(data):
                break
            marker = data[position]
            position += 1
            if marker in (0x01, 0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if position + 2 > len(data):
                break
            length = int.from_bytes(data[position:position + 2], "big")
            if length < 2 or position + length > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                if length < 7:
                    break
                height = int.from_bytes(data[position + 3:position + 5], "big")
                width = int.from_bytes(data[position + 5:position + 7], "big")
                _dimensions(width, height)
                return ".jpg"
            position += length
        raise ValueError("invalid meter JPEG crop")
    raise ValueError("meter crop must be PNG or JPEG")


def _tesseract_executable(configured: Path | None) -> Path:
    if configured is None:
        candidate = next((path for path in _TESSERACT_CANDIDATES if path.is_file()), None)
        if candidate is None:
            raise OcrUnavailable("Tesseract OCR is not installed in a supported local location")
    else:
        candidate = Path(configured)
        if not candidate.is_absolute():
            raise ValueError("configured OCR executable must be an absolute reviewed path")
    if (candidate.name.casefold() != "tesseract.exe" or candidate.is_symlink()
            or getattr(candidate, "is_junction", lambda: False)()
            or candidate.as_posix().startswith("//")):
        raise ValueError("configured OCR executable is not a local reviewed Tesseract binary")
    resolved = candidate.resolve()
    if not resolved.is_file():
        raise OcrUnavailable("Tesseract OCR executable is unavailable")
    return resolved


def recognize_meter_crop(
    image_bytes: bytes,
    request_id: str,
    meter_mode: str,
    expected_mode: str,
    *,
    tesseract_path: Path | None = None,
    timeout_s: float = 5.0,
) -> MeasurementCandidate:
    """OCR one selected crop and parse its provisional display text.

    ``meter_mode`` and ``expected_mode`` are trusted request labels. This does
    not visually verify the dial/mode; the caller must still arrange user
    readback and explicit confirmation before accepting a measurement.
    """
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 160:
        raise ValueError("invalid measurement request ID")
    if meter_mode not in _MODES or expected_mode not in _MODES:
        raise ValueError("meter mode must come from a supported active request")
    if not isinstance(image_bytes, bytes) or not 32 <= len(image_bytes) <= MAX_IMAGE_BYTES:
        raise ValueError("meter crop is missing or exceeds the 2 MB limit")
    if not 0 < timeout_s <= MAX_RUN_SECONDS:
        raise ValueError("OCR timeout exceeds supported bounds")
    suffix = _image_suffix(image_bytes)
    executable = _tesseract_executable(tesseract_path)
    with tempfile.TemporaryDirectory(prefix="ohmpath-meter-ocr-") as directory:
        work = Path(directory)
        os.chmod(work, 0o700)
        crop = work / f"crop{suffix}"
        crop.write_bytes(image_bytes)
        stdout_path = work / "stdout.txt"
        stderr_path = work / "stderr.txt"
        start = time.monotonic()
        with stdout_path.open("wb") as stdout_file, stderr_path.open("wb") as stderr_file:
            process = subprocess.Popen(
                [str(executable), str(crop), "stdout", "--psm", "7", "--oem", "1", "-l", "eng"],
                cwd=work, stdout=stdout_file, stderr=stderr_file, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while process.poll() is None:
                if stdout_path.stat().st_size + stderr_path.stat().st_size > MAX_OUTPUT_BYTES:
                    process.kill()
                    process.wait(timeout=2)
                    raise OcrFailed("OCR output exceeded its limit")
                if time.monotonic() - start > timeout_s:
                    process.kill()
                    process.wait(timeout=2)
                    raise OcrFailed("OCR exceeded its time limit")
                time.sleep(0.02)
        if stdout_path.stat().st_size + stderr_path.stat().st_size > MAX_OUTPUT_BYTES:
            raise OcrFailed("OCR output exceeded its limit")
        if process.returncode != 0:
            raise OcrFailed("local OCR failed; no reading was accepted")
        try:
            text = stdout_path.read_bytes().decode("utf-8", errors="strict").replace("\f", "").strip()
        except UnicodeDecodeError as error:
            raise OcrFailed("OCR returned invalid text") from error
    return parse_meter_candidate(text, request_id=request_id,
                                 meter_mode=meter_mode, expected_mode=expected_mode)
