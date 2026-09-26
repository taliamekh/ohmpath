# Voice, conversation, and the animated guide

Status: implementation plan, not a claim of a working voice prototype. Updated September 26, 2026.

Ohm Path must support a real conversation while the user works: ask a question, hear the next test, read a meter aloud, correct a reading, interrupt an explanation, and ask how to assemble or rebuild the circuit. Voice is an input to the same evidence-based application as typed input, not a separate chatbot with a separate version of the circuit.

## Selected implementation

| Responsibility | Decision | Boundary |
| --- | --- | --- |
| Microphone capture | Electron renderer audio capture, selected device, visible recording indicator | Microphone access is opt-in; no hidden background recording |
| Speech recognition | Local `whisper.cpp`, initially the English `small.en` model, in a persistent laptop worker | Transcribes words only; does not diagnose circuits |
| Acceleration | Validate a pinned Windows Vulkan build on the laptop before enabling it | An RTX model name does not prove runtime compatibility |
| Recognition fallback | Same model on CPU; typed entry remains available | Show slower mode; do not silently select a less accurate model or a paid service |
| Speech detection | Pinned Silero VAD compatible with the selected runtime | Speech detection is not speaker authentication and does not validate a reading |
| Reasoning | Existing subscription-backed Codex connection, through the main orchestrator | No second local reasoning model and no speech-provider conversational agent |
| Spoken output | ElevenLabs Flash v2.5, streamed complete, approved speech segments | Separate ElevenLabs account allowance/billing; not included in the Codex subscription |
| Animation | React-based character renderer, state animations, amplitude-driven mouth movement | Character selection changes presentation, never evidence or safety rules |

The `whisper.cpp` project documents Windows, CPU, Vulkan, NVIDIA acceleration, and VAD support. These capabilities make a single packaged speech worker with a CPU fallback practical; they do not establish this laptop's transcription accuracy or latency. Pin the executable, model, VAD model, and checksums only after the installation proof. [whisper.cpp documentation](https://github.com/ggml-org/whisper.cpp)

`faster-whisper` was considered but is not the initial dependency: its documented GPU path adds CUDA/cuBLAS and cuDNN requirements through CTranslate2. Avoiding that packaging dependency is an engineering choice, not a claim that it has worse transcription quality. [faster-whisper requirements](https://github.com/SYSTRAN/faster-whisper#requirements)

Keep the model loaded between turns. Capture into an in-memory ring buffer; resample to the worker's required mono PCM format. Use bounded utterances and a bounded queue so a noisy microphone cannot create an unlimited transcription backlog. Do not repeatedly launch a command-line process and reload model weights for every phrase.

English is the first evaluated language, not an implied guarantee for all languages. Additional language models are an extension behind the same interface and require their own unit/number tests. Never change language or model silently during a measurement.

## User-facing surfaces

The main workspace shows the live circuit, the current instruction, the selected target, the latest transcript, and a persistent measurement card. Every spoken instruction is also readable. A bottom-right animated guide stays visible while the system is live and can be moved, resized, minimized, or muted without stopping diagnosis.

The first named character is Frieren. Build the character adapter with a simple original placeholder first, then integrate suitable original or licensed animation assets with recorded provenance. Do not describe the placeholder as a completed Frieren asset. The registry supports three guide slots; leave the two unnamed characters unselected until the user chooses them. Do not invent them to fill the menu.

Each character entry contains an identifier, display name, asset manifest, license/provenance record, animation states, subtitle preferences, and an approved ElevenLabs voice identifier. Do not extract or clone a voice actor's performance. Use an authorized synthetic/premade voice unless the user separately supplies an appropriately authorized voice asset.

The character uses the canonical activity states: `idle`, `listening`, `thinking`, `speaking`, `paused`, and `error`. More specific labels are derived presentation substates, not new competing shared states: transcribing describes the active speech worker under `thinking`; explaining accompanies actual playback under `speaking`; awaiting confirmation or uncertain describes the current test while the character is otherwise idle or listening; disconnected is an `error` detail. These labels reflect real application events, never invented model reasoning progress. Alerts must be clear without relying on expression, color, or animation alone. Mouth animation is cosmetic and driven by actual playback, not by the arrival of model text. Support reduced motion and readable text independent of the avatar.

For the initial application the guide sits inside the main window. A later task in the same build adds the optional transparent always-on-top companion window, with a clearly accessible menu and click-through disabled whenever its controls are in use. Both windows subscribe to one session store; neither maintains its own diagnostic history.

## Conversation states and routing

Use two small state machines rather than one state that pretends listening and speaking cannot overlap.

| Input state | Meaning and transition |
| --- | --- |
| Disabled | Microphone not permitted or manually muted; typed input works |
| Ready | Permission granted, capture policy visible, awaiting push-to-talk or enabled hands-free activity |
| Capturing | Buffer only the active utterance; show microphone level and elapsed capture |
| Transcribing | Finalize the utterance; optional partial text is clearly provisional |
| Needs clarification | Missing or ambiguous intent/number/unit; ask a specific question |
| Awaiting confirmation | A complete candidate measurement is displayed and read back |
| Accepted | A completed question or explicitly confirmed measurement has been handed to the bench service |
| Cancelled or failed | Discard pending input, explain the issue, return to ready |

| Output state | Meaning and transition |
| --- | --- |
| Quiet | Nothing playing |
| Preparing | An approved speech segment is queued or being synthesized |
| Playing | Audio and matching subtitles are active |
| Interrupted | Stop local playback, invalidate queued chunks, cancel remote work where supported |
| Unavailable | Show text-only mode; never block the measurement card behind audio failure |

Route completed utterances into four classes:

- **Questions and explanations:** for example, "Why are we testing that?" or "What does that voltage mean?" These may call the reasoning engine with the current evidence snapshot.
- **Results:** for example, "It says minus twelve point five millivolts." These enter the measurement workflow below before they can become evidence.
- **Assembly requests:** for example, "Help me put this back together." These open the assembly workflow, including power-state checks and a validated placement plan; a spoken request never directly authorizes a wiring change or laser movement.
- **Local controls:** stop speaking, repeat, cancel, mute, pause session, and correct the last reading. Handle these locally without waiting for a model turn. If an utterance could mean a measurement or a question, clarify instead of guessing.

A short question should not erase a pending test. Record the paused test, answer the question, then offer to resume that exact test if its revisions remain current. A long interruption, board change, or firmware change requires revalidation before resuming.

## Measurement readback is a transaction

An unconfirmed transcription is never a trusted electrical measurement. The transaction is tied to one active measurement request, not merely to the latest conversation sentence. There is at most one active request per session. The bench service, not the speech worker, is authoritative for acceptance.

1. The orchestrator issues a measurement request with the quantity, required meter mode/range information, probe endpoints, expected power state, target IDs, and current circuit/firmware/calibration revisions.
2. The UI presents a compact instruction and confirms prerequisites before the user probes. Meter configuration and the difference between the two probe endpoints stay on screen.
3. Capture the user's complete utterance. Preserve the raw transcript and timestamp as provenance; never submit partial ASR text as evidence.
4. A deterministic parser extracts sign, decimal digits, unit prefix, unit, and special display states such as `over_limit`. Context may suggest a candidate unit, but it must remain visibly inferred until the readback is confirmed. Do not infer a missing minus sign or choose a plausible value because the simulation predicts it.
5. Read back the complete interpretation in words and display it in digits: "I heard minus twelve point five millivolts DC, red probe at node A, black at ground. Is that correct?" Include the current test label and any mode or endpoint still needing confirmation.
6. Wait for an explicit confirmation or correction. Accept a spoken affirmative only after the readback has completed, for that active confirmation ID, with no pending competing candidate. Silence, a timeout, background speech, the assistant's own voice, and a clipped "yes" do not commit a result.
7. On confirmation, the bench service checks that the request is still active, the single-use confirmation ID is valid, all required revisions match, and the `measurement_context_hash` is unchanged. Power/load, meter mode/range or probe changes cancel/reissue the request even without a graph change. It then stores the explicitly confirmed candidate with `source: voice`, retaining its provenance. User confirmation does not turn a spoken report into instrument telemetry or prove the probes were correctly placed.
8. Corrections append a retraction/replacement event with `supersedes_event_id` referencing the prior accepted reading event. Re-evaluate conclusions based on the corrected value; never silently overwrite the historical reading.

If the user gives a reading with no active request, ask what quantity, meter mode, and probe endpoints it belongs to. Save a note if useful, but do not let an unbound number drive a diagnosis. If camera OCR and spoken input disagree, show both values and ask for a re-read; do not pick whichever is closer to the expected simulation.

Treat "OL" as `display_state: over_limit`, not the number zero. Treat "point two," "two," "twenty," "two hundred," milli, micro, kilo, mega, AC, and DC as materially different. Support explicit digit-by-digit readout and keyboard correction. An ordinary multimeter readout cannot establish a fast waveform merely because a user described it confidently.

### Candidate payload

The [shared contracts](contracts.md) are authoritative. The persisted envelope uses `schema_version`, `session_id`, `event_id`, `event_type`, `source`, `sequence`, `occurred_at`, `received_at`, `circuit_revision`, `firmware_revision`, `calibration_revision`, `correlation_id`, and `payload`. The bench service assigns accepted `sequence` values; the speech worker supplies only its producer ordering. Unknown revisions remain explicit rather than being guessed.

Reuse the canonical measurement request and candidate; do not create an alternative voice-only measurement record:

| Canonical field or requirement | Voice-specific use |
| --- | --- |
| `request_id`, `candidate_id` | Bind the spoken result and explicit confirmation to the requested test |
| Original transcript or crop reference | Preserve the final spoken transcript for a voice candidate |
| Normalized signed numeric value, SI unit, original prefix/unit, original number string | Preserve sign and decimal representation, retaining the reported display unit |
| `display_state` | Exactly `numeric`, `over_limit`, `unstable`, or `unknown`; missing/unparseable displays remain `unknown` with ambiguity details |
| Candidate `source` | `voice`; distinguish this evidence source from the originating component named in the event envelope |
| Parse ambiguities | Record unresolved sign, unit, mode, or endpoint questions; never conceal them with a plausible default |
| Request quantity, meter mode/range, red/black node IDs, and target IDs | Resolve through `request_id`; bind confirmation to these endpoints and the applicable revisions |
| Confirmation naming the candidate and revisions | Follow the canonical candidate lifecycle; speech cannot bypass rejection, clarification, or explicit confirmation |
| `supersedes_event_id` on the correction event | Preserve append-only retraction/replacement history |

The voice adapter additionally needs `utterance_id`, `confirmation_id`, `recognizer_version`, recognition `model_id`, and a readback-completed timestamp. These are proposed voice metadata/confirmation fields to be added by the shared-contract owner during schema implementation, not aliases for canonical measurement fields. A `confirmation_id` binds one readback to one `candidate_id`; it does not replace candidate identity or confer model-callable confirmation authority.

Use a decimal representation for the reported number and explicit unit normalization. Do not interpret a model's confidence score as a calibrated probability that the electrical reading is correct.

## Push-to-talk, hands-free, and interruption

Ship the first end-to-end test with push-to-talk because the user controls utterance boundaries. A keyboard shortcut and a large on-screen microphone control provide the same behavior. The microphone is gated during TTS in this first mode; pressing push-to-talk immediately stops playback before capture. This prevents the system from accepting its own readback as a result or confirmation.

Hands-free conversation is part of the planned product, not a discarded requirement. Enable it after testing voice activity detection, echo cancellation, and interruption on the actual laptop microphone and speakers. Provide explicit listening/muted indicators and an easy return to push-to-talk.

For hands-free mode:

- Request the audio platform's echo-cancellation/noise-suppression processing, but verify it works on the selected device. Do not assume a requested browser audio constraint guarantees acoustic performance.
- Detected user speech may mute/duck playback immediately while transcription catches up. A false interruption is recoverable; a false confirmed reading is not.
- Reject replay of the application's own speech and keep separate utterance, playback, and confirmation IDs. Do not use transcript string matching as the only echo defense.
- A recognized "stop" or "cancel" takes priority over normal conversation routing. Pause the active instruction and request pointer-off through the local safety controller without waiting for cloud reasoning.
- Voice recognition is not a hardware emergency-stop system. Keep the visible stop control, keyboard stop, and independent physical laser disable. Loss of audio, a missed word, or background noise must not defeat fail-off behavior.
- Spoken consent to a reading cannot enable laser emission, move probes, flash firmware, or change wiring. Those actions retain their independent authorization and safety rules.

Stop capture on device removal or revoked permission. Cancel any half-finished measurement confirmation when the input device changes. Explain "I did not get a reliable reading" instead of fabricating an answer from noise or silence.

## Speech output and synchronized pointing

Use ElevenLabs Flash v2.5 with a configured authorized voice. Stream the audio for each complete approved sentence or instruction segment using the HTTP streaming endpoint first. This fits a safety-gated application because the segment's text is available before synthesis. Introduce the TTS WebSocket only if measured latency requires incremental text input and the same validation boundary can be retained. ElevenLabs documents both streaming approaches and recommends Flash for latency-sensitive use. [Streaming guidance](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization), [WebSocket guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)

Never stream unvalidated raw model tokens as physical instructions. Validate the proposed test, allowed quantity/mode, power prerequisites, target IDs, and current revisions before releasing its spoken action. Non-action explanatory text can stream in short complete segments after grounding checks. Avoid splitting a negation, number, unit, or safety prerequisite across segments: "Do not connect..." must not become an isolated "Connect..." after a cancellation.

Use the canonical spoken-instruction record: `instruction_id`, `request_id` where applicable, context revisions, target IDs, approved text segments, safety/measurement tokens, speech status, and cancellation token. Each segment additionally needs a `speech_segment_id` and source evidence references, to be formalized by the shared-contract owner. Subtitles and overlays use the same segment. A local playback generation may help discard old buffers, but it is an internal implementation detail bound to the canonical cancellation token, not a competing cross-service cancellation contract. The local controller resolves target IDs to calibrated locations; the language model does not send servo angles or arbitrary screen coordinates.

An onscreen target may highlight while it is being discussed. Physical pointing is optional and permitted only when the hardware controller's independent checks pass. Laser emission stays off while moving and while the user is probing or handling the board. A spoken test remains usable with overlays alone when physical pointing is unavailable. Do not delay a safety warning while waiting for a servo or a TTS request.

Interruptions, session pauses, circuit edits, firmware changes, and expired calibration cancel affected speech segments and overlays. Late audio chunks from cancelled generations are discarded, not played after the next answer. Network failures must not restart an old instruction from the middle. Offer an explicit repeat of the full current instruction.

## Latency budgets and responsiveness

These are initial acceptance targets to measure, not vendor guarantees or observed results. Benchmark with both camera streams, the avatar, and the diagnostic session running; an isolated ASR benchmark is insufficient.

| Interaction | Initial target | If missed |
| --- | --- | --- |
| Microphone/stop control visual feedback | Within 100 ms locally | Treat as a UI responsiveness defect |
| Local playback stop after button/keyboard/barge-in event | Within 150 ms at p95 | Reduce audio buffering; do not wait for remote cancellation |
| Final transcript after a 2-8 second utterance ends | Within 2 seconds at p95 on the selected accelerated profile | Show transcribing state; profile capture/end-pointing separately from inference |
| Start of audio after a complete approved text segment | Within 1 second at p95 on the tested network | Show text immediately; record provider/network/playback breakdown |
| Explanation or next-test reasoning | Variable; show active work and allow interruption | Do not invent an answer to meet a speech target |

Measure CPU fallback separately and display its actual performance. Keep recognition accuracy gates unchanged when falling back; lower frame-processing load or disclose slower speech before reducing model quality. A larger recognition model is a controlled upgrade if the measurement corpus shows `small.en` insufficient; it requires rerunning latency and semantic tests, not an assumption that size guarantees correctness.

ElevenLabs' advertised approximately 75 ms Flash figure is inference time, not end-to-end microphone-to-answer latency. The full loop includes utterance detection, transcription, evidence checking, reasoning, synthesis, transport, and playback. [Latency definition](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization)

## Privacy, cost, and failure policy

Raw microphone audio stays on the laptop by default and is discarded after processing. Retaining audio for a debugging corpus requires explicit opt-in, an obvious indicator, a retention policy, and review before sharing. Confirmed transcripts/results enter the local session history and may be included in the selected Codex reasoning request. The user-facing setup explains this boundary.

Only text selected for spoken output is sent to ElevenLabs. Keep API credentials in the backend's OS-protected credential store; never embed them in renderer code, a repository, a printed log, or a browser URL. Do not route ElevenLabs through the user's ChatGPT credentials. Use a session speech budget, visible provider status, and no automatic top-ups or paid-provider fallbacks.

Development defaults to a mock speech-output adapter so repeated UI/diagnostic tests do not burn ElevenLabs allowance. Cache user-approved non-sensitive fixed prompts only where account terms allow, with the voice/model/text version in the cache key. Do not cache personalized bench recordings by default. A live ElevenLabs test is a separate verification requiring the user's configured account and chosen spending boundary.

If ElevenLabs is unavailable or its budget is exhausted, continue with subtitles and a visibly declared text-only mode. If the user enables a separate local operating-system voice fallback, label it; do not imply it is the selected character voice. Failure of transcription leaves typed measurement entry available and does not bypass confirmation.

## Acceptance tests and build handoff

The voice implementation owner delivers capture, the speech-worker adapter, transcript/confirmation UI, playback/cancellation, and avatar event bindings behind the agreed shared contracts. The diagnostic owner remains responsible for admitting confirmed evidence; the hardware owner remains responsible for pointer safety. No voice component can directly call the servo/laser driver.

Build and verify in this order:

1. A text-only conversation and measurement-confirmation card using deterministic fake transcripts and fake TTS events.
2. A pinned local speech worker, explicit microphone permission, push-to-talk, and a recorded technical-speech corpus with expected interpretations.
3. End-to-end spoken readings that require complete readback and confirmation; corrections, stale revisions, and restarts are tested before model reasoning consumes them.
4. One bounded live ElevenLabs streaming test, then cancellation, outage, budget-exhaustion, and subtitle-only tests.
5. Bottom-right guide state animation and character registry, followed by the properly sourced Frieren asset and optional companion window.
6. Hands-free detection, acoustic echo tests, barge-in, and local stop priority on the real bench setup.

The corpus must include signed decimals; volts/millivolts; amperes/milliamperes/microamperes; ohms/kiloohms/megaohms; AC/DC; "OL"; uncertain readings; reversed probes; user corrections; questions containing numbers; a missing unit; and digits spoken individually. Include both quiet and realistic noisy bench conditions, differing speaker distances, interruptions, silence, clipped audio, and the assistant's own speech played through the speakers.

Required safety invariants are zero accepted measurements from provisional ASR, silence, self-echo, an expired confirmation, or stale circuit/firmware context in the adversarial suite. Every ambiguous unit, sign, endpoint, and unsupported meter mode in that suite must either be clarified or remain unconfirmed. Passing a finite corpus is regression evidence, not proof that speech recognition can never fail.

Report semantic exact-match rate for value/sign/unit/mode, clarification rate, correction rate, and end-to-end timing distributions; word error rate alone hides dangerous numerical errors. Keep a regression case for each observed failure. The integration walkthrough must demonstrate: ask a question, receive a grounded spoken test, read a result, confirm it, hear what it changes, correct that result, interrupt a response, and resume safely after a board change.
