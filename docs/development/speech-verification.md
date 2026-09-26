# Local synthetic speech verification

Status: **actual local synthesis and Whisper transcription tested; 16 of 17 cases passed after narrow parser updates, with one important node-label failure**. This is synthetic speech, not a microphone, room-noise, physical-meter, or hands-free test.

## Reproduce

Run `.venv/Scripts/python.exe scripts/verify-speech.py` from the repository root. The script reads `fixtures/voice/synthetic-speech-corpus.json`, uses Windows `System.Speech.Synthesis.SpeechSynthesizer` to write private mono 16 kHz, 16-bit WAV files under `runtime/speech-verification`, transcribes them through one persistent local `WhisperWorker`, and feeds each real transcript to `route_utterance` and `parse_reading`. It never sends audio to a speaker, opens a microphone/camera, or calls a paid service. Temporary WAVs are removed. The full per-case JSON report, including timing and parser ambiguities, stays at ignored `runtime/speech-verification/latest-report.json`.

The selected synthesis voice was **Microsoft Zira Desktop**. Installed voices observed: Microsoft David Desktop, Microsoft Zira Desktop, Microsoft David, Microsoft Mark, and Microsoft Zira; only Zira Desktop was used for the corpus. Recognition used the installed local `whisper.cpp` worker with `small.en` (`ggml-small.en.bin`). The latest run took **57.75 seconds** for 17 utterances; median per utterance was **1.829 seconds**, but one `OL` case took **23.453 seconds**. The earlier run took 31.34 seconds. These synthetic timings do not establish microphone latency or p95 product performance.

| Synthetic source | Actual Whisper transcript | Route / parsed result | Accepted by corpus check |
| --- | --- | --- | --- |
| minus twelve point five millivolts | `minus 12.5 millivolts` | reading / −0.0125 V | yes |
| point two seven five volts | `0.275 volts` | reading / 0.275 V | yes |
| two point two volts | `2.2 volts` | reading / 2.2 V | yes |
| one point one volts | `1.1 volts` | reading / 1.1 V | yes |
| three point three volts | `3.3 volts` | reading / 3.3 V | yes |
| zero volts | `0 volts.` | reading / 0 V | yes |
| twelve millivolts | `12 millivolts` | reading / 0.012 V | yes |
| minus zero point two seven five volts | `-0.275 volts` | reading / −0.275 V | yes |
| positive zero point five volts | `positive 0.5 volts` | reading / 0.5 V | yes |
| two kiloohms | `Two kilo ohms.` | reading / 2000 Ω | yes after parser update |
| one megohm | `1 meg ohm` | reading / 1,000,000 Ω | yes after parser update |
| O L | `OL.` | reading / over limit | yes |
| over limit | `Overlimit.` | reading / over limit | yes after parser update |
| Why is node B low? | `Why is node below?` | question / **node B lost** | **no** |
| What should I measure next? | `What should I measure next?` | question | yes |
| yes | `Yes.` | confirmation route only | yes |
| stop | `Stop.` | stop route only | yes |

The first actual run with the old parser accepted **14/17** by numeric/state/route checks; applying the later node-identity criterion to those transcripts makes that **13/17**. The kilo-ohm, meg-ohm, and `Overlimit` transcripts were safely unknown rather than accepted as measurements. The coordinator then updated the parser to handle those exact variants while preserving the original transcript and the separate readback/confirmation gate. The next actual run scored **16/17**. `Why is node B low?` still became `Why is node below?`; recognizing it as a question does not preserve the requested target, so the script marks it failed. A product flow must ask for clarification before acting on a lost node identity.

The pre-existing `runtime/synthetic-meter-speech.wav` was also transcribed separately: `minus 12.5 millivolts`, final status, reading route, parsed −0.0125 V with no parser ambiguity. This is another synthetic sample, not physical evidence.

Files owned in this slice: `scripts/verify-speech.py`, `fixtures/voice/synthetic-speech-corpus.json`, and this handoff. No audio file, dependency manifest, service API, microphone permission, account setting, or device state was changed. The script exits with status 1 while any corpus case fails, so the current nonzero exit is expected and visible.

Suggested plain-English commit title after coordinator review: `Add repeatable local synthetic speech verification`.
