# Meter OCR handoff

Status: **bounded adapter and parser replay complete; actual optical recognition unavailable on this laptop until a local OCR executable is installed**. No image was reported as physically measured or confirmed.

## Implementation

- `services/bench/src/ohmpath/vision/ocr.py` exposes `recognize_meter_crop(image_bytes, request_id, meter_mode, expected_mode, *, tesseract_path=None, timeout_s=5.0) -> MeasurementCandidate`. Import it directly from `ohmpath.vision.ocr`; no shared API or contract changed.
- It accepts a selected PNG/JPEG crop of at most 2 MB, 4096 pixels per side and 8 megapixels. It checks format/dimensions before launching a fixed local Tesseract command. The crop is kept in a temporary directory and removed after the run. The subprocess has an 8-second maximum configurable bound and 32 KB combined output cap. No shell, arbitrary arguments, network OCR, or raw image logging is used.
- It passes the uncorrected OCR text to the existing conservative `parse_meter_candidate`. `OL`, signed decimal, unit prefixes and case, missing units, mode mismatch, and ambiguous characters retain the parser's provisional behavior. The mode labels come from the active user request/configuration; this module does **not** visually verify the meter dial or mode. It does not write a session event, complete readback, confirm a measurement, or control hardware. One crop cannot establish temporal display stability.

## Verification

- No `tesseract.exe` was found on PATH or in the supported Program Files/LocalAppData Tesseract locations. The environment also lacks Python `winrt`, `winsdk`, `pytesseract`, `PIL`, and `cv2`. A read-only Windows OCR capability query required elevation, so its availability is unverified. No package or OCR service was installed.
- `.venv/Scripts/python.exe -m pytest services/bench/tests/test_meter_ocr.py services/bench/tests/test_vision_meter.py -q`: **21 passed**. These are parser checks and **mocked OCR subprocess** replays, including cleanup, missing executable, unsafe image/mode, timeout, excess output, `OL`, unit-prefix case, and mismatched mode. They are not proof that an image can be read on this laptop.
- `.venv/Scripts/python.exe -m pytest services/bench/tests -q`: **287 passed**, one upstream FastAPI TestClient deprecation warning.
- `.venv/Scripts/python.exe -m ruff check services/bench/src/ohmpath/vision/ocr.py services/bench/tests/test_meter_ocr.py`: **All checks passed**.

## Next integration step

The free dependency is **Tesseract OCR for Windows with English traineddata**, with `tesseract.exe` at `C:/Program Files/Tesseract-OCR/tesseract.exe` or an explicitly reviewed absolute `tesseract_path` owned by the backend. The coordinator should install/review it only if authorized, then add a real photographed or synthetically rendered meter-crop test. Until then, surface OCR as unavailable and retain typed/voice candidate workflows. If connected to a UI, show OCR text and the requested mode for user readback; only the separate current request/confirmation path may accept a measurement.

No shared schema, dependency manifest, API route, or other agent-owned file changed. Suggested plain-English commit title after review: `Add a bounded provisional meter OCR adapter`.
