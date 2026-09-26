# Integration safety review

Review scope: the current session measurement/store/API/reporting changes, Pi video server, and desktop Pi video client. This was a read-only implementation review; no hardware, camera, live model, or network connection was used.

## Previously reported question-summary label issue — fixed

The question endpoint now labels each reading from its event `evidence_kind` (“practice input” or “user-reported reading”) and selects the corresponding practice/manual limitation. The event still explicitly distinguishes user-reported data from independently verified instrument data. The previous B/GND supervised-session reproduction no longer applies; the coordinator reports adding a regression.

## Correction-target issue found and fixed during review

The initial implementation allowed a confirmed reading to supersede any confirmed event in the same session, regardless of circuit, measurement context, or probe endpoints. Since the reading index excludes events referenced by any superseder, a reading at unrelated probes could disappear from the evidence index. The coordinator added checks for circuit revision, measurement context, quantity/mode/endpoints, and already-corrected targets, along with regressions for unrelated readings and duplicate correction. I inspected this change; the regression tests pass.

## Other reviewed boundaries

- Manual and mock confirmation use separate `evidence_kind` values. OCR and voice entries still use the candidate/readback/confirmation flow, and current diagnosis context checks filter out readings whose setup hash no longer matches.
- Write and confirmation endpoints are user-scoped; model-only endpoints are separately scoped to simulation and proposed tests. A proposed test is not an execution command, and the reviewed code exposes no route that enables laser emission or actuates a motor.
- The report explicitly states physical verification is pending, preserves reading evidence type, and omits raw audio, images, firmware logs, free-form conversation, and tokens.
- The Pi camera process is opt-in, binds to loopback, requires a per-launch bearer token, bounds FPS/JPEG size/client count, disables request logging, rejects stale or malformed frames, and releases the camera on server close. The desktop client uses a fixed loopback port target, sends the token in an authorization header, does not log it, bounds frame parsing, and drops the latest frame on disconnect. I found no additional high-impact issue in these paths during this pass.
- Circuit graphs cap components at 128 and model/value validation rejects unsupported models and non-finite values. The simulator reports `provenance="none"` if no executable-backed process was started, and convergence/fatal log output cannot yield success. I confirmed node parsing uses requested-node subset checking and the laboratory parser checks the exact number of columns, not only a prefix. Missing executable and fatal-output cases have focused regressions. No additional simulator integrity issue was identified in this pass.

## Verification

Focused read-only test run after the correction-target, question-label, and simulator parser changes:

```text
.venv\Scripts\python.exe -m pytest services\bench\tests\test_circuits.py services\bench\tests\test_laboratory.py services\bench\tests\test_session.py services\bench\tests\test_measurement_review.py services\bench\tests\test_report.py services\bench\tests\test_integrated_tools.py services\pi\tests -q
69 passed, 1 warning in 4.53s
```

The warning is Starlette's deprecation notice about `httpx` in its test client. No implementation files were changed by this review.
