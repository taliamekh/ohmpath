# Windows built-in OCR helper handoff

Status: **helper implemented; runtime OCR verification blocked by the machine's PowerShell execution policy**. The helper uses only the existing Windows.Media.Ocr WinRT API from stock Windows PowerShell 5.1. No Tesseract installation was attempted, no execution policy was changed or bypassed, and no Windows capability query or elevation was used.

## Input and output

The fixed helper path is `services/bench/src/ohmpath/vision/windows_ocr.ps1`. It takes one explicit local image crop with `-InputPath` and a `-TimeoutSeconds` bound (1–20, default 10). It accepts PNG, JPEG, or BMP files up to 10 MB and 8 megapixels / 4096 pixels per side. Reparse-point files and non-local paths are rejected. It opens only the named file; it does not capture from a camera, display a UI, write the crop, or call another program.

Stdout is one UTF-8 JSON object with `schema_version`, `status`, `provider`, `provenance`, `confirmed: false`, `candidate_text`, `lines`, `source_sha256`, and a sanitized `error`. OCR text remains a **candidate**; this helper does not parse meter units or confirm/accept measurements. If Windows.Media.Ocr is unavailable for the user's installed languages, status is `unavailable` and the text stays empty. Errors/timeouts similarly return no recognized text. Input paths and exception details are not returned.

Run with the user's existing PowerShell policy, without adding an `ExecutionPolicy` flag:

```powershell
powershell.exe -NoProfile -NonInteractive -File services/bench/src/ohmpath/vision/windows_ocr.ps1 -InputPath C:\private\crop.png -TimeoutSeconds 10
```

No package install, paid service, account, cloud route, hardware, or UI is needed.

## Verification

Command: `.venv/Scripts/python.exe -m pytest services/bench/tests/test_windows_ocr.py -q`

Result: **1 passed, 2 skipped in 1.16s**. The static safety test passed. Both runtime tests attempted ordinary `powershell.exe -File` execution and were blocked before the script ran with Windows' message: `running scripts is disabled on this system`. No execution-policy override was attempted. Consequently, built-in OCR language/runtime availability and recognition of the generated `-12.5 mV` synthetic crop are **not verified** on this host. The actual-OCR test will run automatically on a machine where stock PowerShell 5.1 may execute the reviewed local script under its existing policy; it accepts a fail-closed `unavailable` result when no language is installed.

The tests create their synthetic crop in the test temporary directory with the existing .NET `System.Drawing` API. No fixture image is added to the repository. This is not a Tesseract or physical-meter test.

Changed paths:

- `services/bench/src/ohmpath/vision/windows_ocr.ps1`
- `services/bench/tests/test_windows_ocr.py`
- `docs/development/windows-ocr-handoff.md`

No shared schemas, dependencies, or API manifests changed. Proposed commit title: **Add a private local Windows OCR helper**.
