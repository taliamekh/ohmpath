# Shared data and service contracts

Status: design contract for implementation. These are Ohm Path domain fields, not copied Codex or ElevenLabs wire schemas. Final JSON Schema and generated bindings will live in `packages/contracts`; the coordinator owns changes.

## Ownership

The bench service is the sole authority for accepted session/evidence state. UI, model, voice, and vision submit candidates or commands; they do not directly update confirmed evidence. The Pi is authoritative for its local fault, armed state, and executed command acknowledgment, not the circuit diagnosis. Only local authenticated user actions can confirm evidence or request arming.

## Event envelope

Every persisted application event contains:

| Field | Meaning |
| --- | --- |
| `schema_version` | Contract version; reject unsupported major versions |
| `session_id`, `event_id` | Stable opaque session identifier and unique event identifier |
| `event_type`, `source` | Named event and originating component |
| `sequence` | Monotonic sequence assigned by the bench service when accepted |
| `occurred_at`, `received_at` | UTC source and receipt timestamps; source clocks are not assumed identical |
| `correlation_id` | Links the question/test/turn and resulting events |
| `circuit_revision` | Accepted intended/observed circuit state, or explicit unknown |
| `firmware_revision` | Relevant source/configuration/deployed identity, or explicit unknown |
| `calibration_revision` | Relevant geometric calibration, or explicit unknown |
| `payload` | Validated event-specific fields |

Producer messages have a producer sequence before acceptance; they cannot assign the authoritative session sequence. Video uses `frame_id`, camera ID, capture age, source sequence and geometry metadata rather than filling the durable event log with each frame. Freshness checks use local monotonic clocks and measured link age; never depend on subtracting unsynchronized Pi/laptop wall clocks.

Corrections append new events with `supersedes_event_id`. No silent overwrite. Reconnection can resume ordinary events after the last accepted sequence; non-idempotent actions are never replayed automatically.

## Core records

### Circuit revision

Contains design hash, observed-layout hash, graph nodes/nets/components/pins, values and tolerances, supported analyses, model/pin-map versions, power envelope, and evidence for confirmed mappings. Revision metadata records the change and who accepted it. A suspected board movement invalidates geometry; a suspected rewiring suspends affected tests until reconciled. Do not classify every hand passing through the image as a confirmed circuit change.

### Measurement request and candidate

`request_id`, quantity, meter mode/range, black/red node IDs, target IDs, power prerequisites, permitted units, context revisions, expiry, and status. At most one active request per session.

Also bind the request and confirmation to a `measurement_context_hash` covering the accepted power/operating/load condition, meter mode/range, probe endpoints, instrument identity and applicable revisions. Any reported or detected setup change cancels the pending candidate and cancels/reissues the request even when the circuit graph is unchanged. A delayed "yes" cannot confirm a reading after someone switches meter mode or supply state. Unknown setup details remain unknown and block claims that depend on them.

A candidate contains `candidate_id`, `request_id`, original transcript or crop reference, normalized signed numeric value if present, SI unit, original prefix/unit, display state (`numeric`, `over_limit`, `unstable`, `unknown`), source (`voice`, `ocr`, `typed`, future instrument), and parse ambiguities. No bare float without dimensional units. Retain the original number string/decimal representation to avoid losing precision or a sign.

Candidate lifecycle: captured → parsed → needs clarification/readback → explicitly confirmed or rejected → stored. A confirmation names the exact candidate and revisions; a generic delayed "yes" is insufficient. Confirmation authority is not exposed to the model's MCP tools. Correction supersedes the earlier record and triggers re-evaluation. Out-of-expectation values remain evidence when confirmed; out-of-safe-envelope values trigger a stop/review.

The bench service issues a single-use `confirmation_id` bound to candidate ID, request ID, context hash, readback completion and expiry. Final voice input can propose an affirmative response to this pending challenge; only the user-interaction confirmation path can accept it. Model/tool output cannot impersonate that source. Candidate voice metadata may include `utterance_id`, recognizer/model versions and original transcript; these do not replace the common source/provenance fields.

### Simulation job/result

`simulation_id`, input/netlist hash, circuit revision, variant ID, analysis type, model-library hashes, engine/version, bounded execution parameters, status, actual output values with units, exit code, logs, warnings and convergence outcome. A failed run contains no invented success table. Graph calculations have a distinct provenance type from simulator outputs and physical measurements.

### Diagnostic proposal

Contains hypothesis IDs with supporting/contradicting evidence IDs, unresolved assumptions, proposed next test, reason it helps discriminate, safety prerequisites, semantic targets, and approved user-facing explanation. Validate all references. A heuristic score is not a calibrated probability. The proposal is not accepted merely because it is valid JSON.

### Spatial target and aiming state

`target_id` is a semantic feature (for example a test-pad label), never just an ephemeral pixel. Store board/plane ID, board-space geometry in millimetres, linked node/component, height/depth assumption, safe pointing region, mapping source, uncertainty, and calibration revision. Each camera derives its own pixel coordinates with a recorded transform.

`aim_state` includes target ID, Pi frame ID, target pixel, predicted crosshair pixel, optional observed spot pixel, pixel error, pose validity/age, control phase (`idle`, `acquiring`, `moving`, `settling`, `aligned`, `fault`), iteration count, and relevant revisions. Mark prediction versus physical observation explicitly. No spot detection is implied by drawing a crosshair.

The local controller computes bounded yaw/pitch changes, but model-facing tools accept only a target proposal. Physical authorization resolves it to the allowed pointing surface. An intended electrical node and a nearby matte pointing label may be different geometry linked to the same instruction.

Maintain a separate `hardware_safety_state`: disarmed/ready/moving/settling/indicating/fault, physical-enable state, watchdog health, stop/fault reasons, and current connection/arming epochs. `aim_state.aligned` never implies armed or emitting. The UI displays these independently.

### Spoken instruction and character state

`instruction_id`, `request_id` if applicable, context revisions, target IDs, approved text segments, safety/measurement tokens, speech status, and cancellation token. Segment-start events may focus the related onscreen target; physical actions still require independent authorization. A player buffer is flushed on cancel, not merely a network request aborted.

Avatar state is derived from actual activity (`idle`, `listening`, `thinking`, `speaking`, `paused`, `error`), not invented reasoning progress. Character metadata cannot alter measurement text, confirmations, safety policy, or tool scope.

## Interfaces

| Boundary | Planned interface | Constraints |
| --- | --- | --- |
| Renderer ↔ bench | Versioned local HTTP actions + WebSocket events | Loopback, per-launch authentication, origin checks, small bounded messages |
| Bench ↔ Codex | Supervised stdio adapter | Separate protocol mapping; capability and restrictive-permission checks |
| MCP bridge ↔ bench | Narrow authenticated local requests | Read/query/simulate/propose only; no user confirmation or device arming |
| Bench ↔ simulator | Fixed executable, argument array, approved input workspace | Timeout, resource/output limits, safe model paths, run-specific cleanup |
| Bench ↔ Pi | Authenticated private Ethernet control; separate latest-frame video | Pin paired identity; no default gateway on bench link; no public control port |
| Speech worker ↔ bench | Bounded audio segments and final/candidate events | No raw audio logging by default; cancellation and worker health |
| Bench ↔ ElevenLabs | Outbound approved text, inbound streaming audio | Backend credentials, budget gate, cancellation, no capture permission implied |

For the Pi link, use an SSH tunnel with pinned host identity to localhost-bound services for the prototype. If later moved to a routable network, review transport and pairing before opening any ports. Control and video must not share an unbounded queue.

Use separate underlying SSH/TCP connections for video and control, not multiplexed channels on one shared connection that can stall control behind video traffic. Local forwarding endpoints also bind to loopback. Issue different scoped capabilities to the renderer's user-action path and the MCP bridge; never give MCP the renderer's confirmation/arming authority or a shared unrestricted token.

## Action protocol and fail-safe behavior

Each control request carries `command_id`, session/revisions, target or bounded actuator operation, expiry/TTL, and a capability issued by the safety service. Pi acknowledges `accepted`, `rejected`, `completed`, or `fault`; transport delivery is not motion completion. A repeated command ID returns its previous result, not another move. Open-loop servos cannot report actual achieved angles; completion requires the relevant observation/check.

Bind authorization to a fresh connection epoch, current arming epoch, and canonical command-payload hash. Disconnection/restart invalidates the connection epoch; every disarm invalidates the arming epoch. Reuse of a command ID with a different payload is rejected, not treated as an authorized retry. Neither a resumed session nor an old queued command can restore a previous arm state.

The mock command receiver enforces the configured minimum step interval even for very small moves. Wire retry identity binds the original TTL and excludes the locally reconstructed monotonic deadline; direct in-process commands without a wire TTL bind their explicit deadline. Reset positions reject Boolean/non-numeric inputs as well as non-finite or out-of-range angles. These software guards do not constitute physical driver validation.

No blind retry after an unknown outcome. Reconcile device state, disarm, and require fresh user authorization where needed. A new session, stale heartbeat, calibration loss, target loss, unknown pose, movement, camera disconnect, or stop request disables emission. Independent normally-off hardware and physical stop remain mandatory; a network heartbeat alone is not sufficient.

## Error policy

Use stable readable error names such as `measurement_context_changed`, `calibration_stale`, `simulation_failed`, `voice_ambiguous`, `model_unavailable`, `allowance_unavailable`, and `device_disconnected`. Return actionable UI text, retryability, affected scope, and recovery prerequisite. Never hide an error with a plausible AI answer or leave the previous valid-looking overlay active.

Schema tests must include missing units, impossible references, expired commands, duplicate events, out-of-order notifications, reconnects, a delayed voice confirmation, firmware mismatch, and a board change during a model turn.

Also test a meter-mode or power change without a graph revision, conflicting payloads for the same command ID, stale arming epochs, and an MCP request to a user-only confirmation endpoint.

## Photo help (implemented additive user API)

Photo help is independent of circuit sessions. It never inherits a practice graph, writes accepted measurements, creates actuator commands, or supplies model tools.

- `POST /v1/photo-help/investigate`: `{context_id, question, images}`. IDs are UUIDs, question is 1–4,000 characters, and images contain 1–3 `{image_id, mime_type, image_base64}` records. Accept PNG/JPEG only, at most 2,000,000 decoded bytes and 8 megapixels per image. Main-process native decoding/re-encoding strips original metadata; HTTP validation independently checks bounded image structure. The larger 8.2 MB request cap applies only to this exact route.
- `GET /v1/photo-help/{turn_id}` returns `{turn_id,status,context_id,image_revision,answer?}`. `image_revision` is a SHA-256 string over the ordered image identities/content. Status is `running`, `completed`, `failed`, `cancelled`, or `stale`.
- `answer` contains `explanation`, `observations`, `questions`, `next_steps`, `annotations`, and `limitations`. Each of at most eight annotations has a current `image_id`, normalized finite `x,y` in [0,1], and bounded `label`. These are suggested visual locations, never calibrated physical targets or verified electrical facts.
- `POST /v1/photo-help/cancel`: `{context_id,turn_id?}`. Context-only cancellation also removes follow-up history, invalidates completed answers and records a bounded cancellation tombstone so a racing late start fails. The interface creates a fresh context after Stop or an image change. Late initial responses receive another explicit cancel.

All three routes require the local user capability; the model capability cannot access them. One shared admission lock prevents simultaneous circuit/photo investigators. The runtime verifies the selected subscription/model/allowance, disables provider fallback, exposes zero dynamic or MCP tools, bounds the entire preflight/turn to 90 seconds and removes temporary image files. The last three completed question/explanation pairs can accompany follow-ups for the same images. Contexts/jobs are bounded in memory and are not durable evidence.

Renderer photo IPC passes main-process-owned opaque image IDs. `photoImportCapture` imports only a user-selected snapshot; its renderer timestamp is a freshness guard, not independent proof of physical camera state. Image selection/import does not initiate a model request. An explicit Ask sends the selected pixels and question.

`photoChooseImage` accepts a local PNG/JPEG source of at most 16,000,000 bytes, 32 megapixels and 8192 pixels per side. Structural limits are checked before native decoding. EXIF orientation is applied once, metadata is removed, and a bounded resize/encoding pass produces the unchanged HTTP limits above. Prepared images have a maximum preferred side of 2400 pixels. The returned local preview may include `original_width`, `original_height` and `resized`; these are display metadata and are not transmitted as evidence. Original files are never overwritten.

`photoPasteImage` reads only the current clipboard image after an explicit Paste image click. It never reads clipboard text/files or alters clipboard content. It validates native dimensions before copying pixels, resizes a copy to at most 2400 pixels per side and re-encodes bounded pixels without original metadata. It returns the same local preview shape and opaque ownership ID as file selection. Neither selection route calls the model until Ask.

The standalone Photo help workspace retains images and completed replies in memory across navigation. Leaving cancels unfinished work and invalidates late imports; Clear workspace cancels the context, releases images and clears the question/history. Quitting or reloading discards the temporary workspace; it is not a persisted photo project. The camera review drawer has a separate temporary context and releases it when leaving Camera help.

`piVideoStatus` is read-only desktop IPC returning `connected`, `state`, optional `reason`, `fresh_frame` and a constant source description. State is `disconnected`, `connecting`, `waiting`, `streaming`, `stalled` or `failed`. No token is returned. The client clears its latest frame on failure, refuses frames older than two seconds and fails after five seconds without a valid frame. The interface clears failed previews and requires an explicit reconnect; a prior frame cannot stand in for a current camera view.

`turretStatus` / `setTurretEnabled` are local preference IPC, not actuator authorization. Their returned `connected`, `motion_enabled` and `laser_enabled` are false in this build. Enabling the preference does not bypass pairing, calibration, arming or physical acceptance prerequisites.

Companion state adds optional presentation-only `expression`: `neutral`, `thinking`, `stumped`, `happy`, `smug`, or `weary`. It cannot change reasoning, evidence, measurement acceptance or safety. Mouth animation follows an actual playback activity callback; animation assets do not constitute voice verification.

Camera focus mode keeps the existing preview mounted. Snapshot review uses the same Photo help API and explicit Ask disclosure inside the workspace. Hiding the review drawer preserves its context; leaving the workspace cancels it. Subtitles render the actual explanation or current readback without invoking a speech provider. Readback has priority over decorative guide text. The subtitle preference is local presentation state and cannot acknowledge or confirm a measurement. Full explanations remain available in the camera subtitle pane; the separate desktop companion's IPC caption remains capped at 500 characters.

Shared explanation wording may be calm, reserved and lightly humorous. This presentation instruction applies only to the explanation field. Structured observations, questions, proposed tests, exact quantities/units, safety text and evidence validation retain their independent rules.

## Optional phone photo and speech presentation interfaces

Phone photo transfer is an opt-in helper separate from the loopback bench API. `phonePhotoStart({address})` binds only an explicitly selected private IPv4 adapter. The link expires after 15 minutes and carries a random bearer capability in its URL fragment. Only the phone's explicit Send transmits the bounded photo/question to the laptop. Main-process decoding removes original metadata and gives the renderer an owned image ID; the laptop's explicit Ask remains necessary for reasoning. The helper offers no bench, microphone, speech, or hardware control. Trusted-network HTTP is unencrypted and the UI discloses this limitation. See [transport limits](../development/phone-photos.md).

`phonePhotoStatus` returns `{active,url,expires_at,address,received_count,qr_data_url,pending,interfaces}` to the trusted main renderer only. `phonePhotoSetAccepting({accepting})` gates incoming images by workspace readiness. `phonePhotoTake` consumes one pending `{image,question}`; late results must be released after navigation or capacity changes. `phonePhotoStop` invalidates the token, closes sockets and releases a pending image. Quit and renderer failure also close sharing.

`POST /v1/voice/transcribe-question` accepts `{wav_base64}` with the local user capability only. The 2.1 MB request cap permits a bounded mono 16 kHz PCM16 WAV; the worker enforces 20 seconds and 1.5 MB decoded audio. It returns `{text,status,local_only:true}`. This route only transcribes into an editable question draft: it cannot create a session event, candidate, readback, confirmation, or model turn. No session ID is required. The model capability cannot access it.

`elevenLabsSetGenerationEnabled({enabled,characterBudget})` explicitly enables optional spoken answers for this process, with a maximum launch budget of 1,000 text characters and 1,000 conservatively reserved credits that cannot be replenished by toggling. Every launch starts disabled. `elevenLabsSpeak({request_id,text})` requires fresh subscription, overage, selected premade voice and exact model metadata checks. Credit reservations remain spent locally after a possibly transmitted request, even after cancellation. No automatic generation, retry, top-up or provider fallback exists.

The main process sends bounded `ohmpath:speech` events (`start`, `chunk`, `end`, `cancelled`, `error`) to the main renderer only. PCM is signed little-endian 16-bit mono at 24 kHz; each chunk is at most 48 KiB and each utterance at most 8 MiB. The player buffers bounded PCM and schedules only a short playback window. Cancellation stops both network work and scheduled audio. `speaking` animation starts from the running audio player's callback, never merely from a text response. Navigation, context changes, microphone capture and Stop invalidate prior playback. Natural readback completion may acknowledge listening; the separate measurement confirmation remains mandatory. No speech event can directly confirm evidence or actuate hardware.

## Local visual point observations

`POST /v1/vision/track` is a user-only route for `{context_id,source,sequence,image_base64,point?}`. The context is a canonical UUID, source is `overview` or `pi`, sequence increases per context, and point is an explicit normalized `{x,y}` selection. The renderer reduces opt-in frames to at most 640 × 480 JPEG pixels and sends one frame at a time; the service caps the raw request at 720 KB, base64 at 700,000 characters, decoded images at 512 KiB and 1280 × 960 pixels. The model capability cannot call it.

Responses contain `{context_id,source,sequence,status,target,quality,message,local_only:true,observation_only:true}`. Status is `idle`, `tracking` or `lost`; target is normalized image position or null. Quality metrics are heuristics, never electrical confidence. A selected patch is not a semantic component, confirmed connection, calibrated aiming crosshair or physical measurement. Tracking does not write the evidence ledger, call cloud reasoning or command hardware.

Two volatile contexts are permitted. Ambiguous matches, stale frames, source or size changes lose the target. Loss requires a new explicit selection; there is no automatic reacquisition. `POST /v1/vision/reset` discards a context. Processing/reset contention returns 409, so the renderer invalidates old replies immediately and retries cleanup within a bounded period. Navigation, Stop, disconnection and pause remove the overlay and stop sending frames. Semantic circuit interpretation remains the separate, explicit snapshot question path.

## Direct phone live camera

`phoneLiveStart({request_id,offer:{type:'offer',sdp}})` is trusted main-renderer IPC only. The canonical UUID identifies a cancellable setup request. An isolated loopback signaling bridge starts a temporary HTTPS Quick Tunnel; the desktop checks public-page reachability before returning a QR code. `phoneLiveCancelStart({request_id})` aborts only the matching pending setup. `phoneLiveStatus({session_id?})` returns `{active,session_id,state,url,answer,error,expires_at,qr_data_url?}` and refreshes the matching renderer lease. `phoneLiveStop({session_id})` cannot stop a replacement session through a stale identifier.

The phone helper exposes only generic `GET /`, bearer-authenticated `GET /session`, `POST /answer` with `{session_id,client_id,answer:{type:'answer',sdp}}`, and `POST /stop` with `{session_id,client_id}`. It binds loopback only, validates exact tunnel Host/Origin, caps JSON at 80 KiB and SDP at 64 KiB, and accepts video-only media sections. One client can claim an answer; retries must carry the same client, current session ID and exact answer. An authenticated phone can cancel before an answer is claimed. Waiting media offers expire after ten minutes; active sessions have a two-hour ceiling and require both renderer and phone heartbeats. Stop/lease expiry clears only media state; the idle pairing portal retains its URL/token until app shutdown or tunnel failure. `link_available` distinguishes that reusable portal from `active` media. Idle `/session` returns `{active:false,state:'idle',session_id:''}`; active responses include `active:true`. Each new media session gets a fresh ID, and stale phone mutations return 409. Desktop tokens/SDP are volatile and never logged. App quit waits for portal/helper shutdown, including when the bench child has already exited.

The random 32-byte pairing capability is carried in the QR fragment and scrubbed from phone history. Same-tab session storage retains that token for an explicit reconnect/refresh; no frames or audio are stored. HTTPS provides the browser's secure camera origin; Cloudflare carries page/signaling traffic, including connection candidates. Video uses direct encrypted WebRTC with no configured STUN/TURN relay, no microphone and no continuous model transmission. There is no fallback to a paid provider or insecure camera origin. The phone's explicit Start enables capture each time; Stop, hidden page and connection failure stop its tracks. See [implementation and verification boundary](../development/phone-live-camera.md).

Received phone frames occupy the existing `overview` source and retain its observation-only semantics. Snapshot capture preserves at most 2400 pixels on the longer side without upscaling, under the existing 2 MB image bound; the unchanged image ownership and explicit Ask flow apply. Local tracking remains a separate opt-in action. Neither pairing, streaming, tracking nor capture can confirm a measurement or authorize hardware.

Suggested circuit framing is display-only. A normalized `focus_region` belongs to the original image and is removed before the snapshot-import IPC call; the locally returned image may carry it solely for rendering. Full-frame pixels, hashes and annotation coordinates do not change. The live viewport and local tracking pointer share one crop-to-original coordinate transform. Whole-view controls and manual center selection override the suggestion; unknown/ambiguous framing keeps the original view. A tracked point outside a close-up is labeled as outside the view instead of displaying an incorrect marker. Framing cannot create evidence or act on hardware.
