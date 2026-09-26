from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


SCRIPT = Path(__file__).parents[1] / "src" / "ohmpath" / "vision" / "windows_ocr.ps1"
POWERSHELL = shutil.which("powershell.exe")
pytestmark = pytest.mark.skipif(POWERSHELL is None, reason="stock Windows PowerShell 5.1 is unavailable")


def draw_private_synthetic_crop(path: Path) -> None:
    # Fixed PowerShell source; the output path is provided only through the environment.
    command = r"""
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new(1200, 300)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = [System.Drawing.Font]::new('Arial', 72, [System.Drawing.FontStyle]::Regular)
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawString('-12.5 mV', $font, [System.Drawing.Brushes]::Black, [single]50, [single]80)
    $bitmap.Save($env:OHMPATH_SYNTHETIC_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
"""
    env = dict(os.environ)
    env["OHMPATH_SYNTHETIC_PNG"] = str(path)
    completed = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
                               capture_output=True, timeout=15, check=False, env=env)
    if completed.returncode != 0:
        pytest.skip("System.Drawing cannot create the temporary OCR test crop on this host")
    assert path.is_file() and path.stat().st_size > 0


def run_helper(path: Path) -> tuple[dict, bytes]:
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(SCRIPT),
         "-InputPath", str(path), "-TimeoutSeconds", "10"],
        capture_output=True, timeout=25, check=False,
    )
    stderr = completed.stderr.decode("utf-8", errors="replace")
    if "running scripts is disabled on this system" in stderr.casefold():
        pytest.skip("Windows execution policy blocks this .ps1; no policy override was attempted")
    assert completed.returncode == 0, stderr
    assert completed.stdout and not completed.stdout.startswith(b"\xef\xbb\xbf")
    payload = json.loads(completed.stdout.decode("utf-8"))
    assert completed.stdout.count(b"\n") == 1
    return payload, completed.stdout


def test_builtin_ocr_emits_local_candidate_for_explicit_synthetic_crop(tmp_path: Path):
    image = tmp_path / "private-synthetic-meter.png"
    draw_private_synthetic_crop(image)
    payload, raw = run_helper(image)
    assert payload["provider"] == "Windows.Media.Ocr"
    assert payload["provenance"] == "local_ocr_candidate"
    assert payload["confirmed"] is False
    assert len(payload["source_sha256"]) == 64
    assert str(tmp_path) not in raw.decode("utf-8")
    if payload["status"] == "unavailable":
        assert payload["candidate_text"] == ""
        return
    assert payload["status"] == "succeeded", payload["error"]
    normalized = payload["candidate_text"].replace("−", "-").replace("—", "-")
    assert "12.5" in normalized
    assert "mv" in normalized.casefold()
    assert "-" in normalized


def test_helper_rejects_non_image_and_oversized_crop_with_json_only(tmp_path: Path):
    invalid = tmp_path / "private-note.txt"
    invalid.write_text("not an image", encoding="utf-8")
    payload, raw = run_helper(invalid)
    assert payload["status"] == "failed"
    assert payload["confirmed"] is False and payload["candidate_text"] == ""
    assert "PNG, JPEG, or BMP" in payload["error"]
    assert str(tmp_path) not in raw.decode("utf-8")

    oversized = tmp_path / "too-large.png"
    with oversized.open("wb") as handle:
        handle.truncate(10 * 1024 * 1024 + 1)
    payload, raw = run_helper(oversized)
    assert payload["status"] == "failed"
    assert "10 MB" in payload["error"]
    assert len(raw) < 2048


def test_helper_source_is_explicit_local_candidate_only_and_keeps_policy_untouched():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "TryCreateFromUserProfileLanguages" in source
    assert "local_ocr_candidate" in source and "confirmed = $false" in source
    assert "Get-FileHash" in source and "10MB" in source and "8000000" in source
    assert "ExecutionPolicy" not in source and "Set-ExecutionPolicy" not in source
    assert "powershell.exe" not in source.casefold()
