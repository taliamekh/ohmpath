# Investigator runtime integration proof

On 2026-09-26, the coordinator separately authorized three bounded
subscription-backed `gpt-6-astra`/medium proof attempts. Fresh ordinary
subscription allowance was checked before each; the final check showed 96%
remaining. No reset or API-key fallback was used by this proof. The one-shot
script is [`scripts/prove-investigator.py`](../../scripts/prove-investigator.py).
It requires `--authorized-live-proof`, creates separate random user/model
capabilities for a temporary loopback bench, and writes aggregate reports
under ignored `runtime/investigator-proof/`. It does not persist or print
capabilities, account identifiers, opaque evidence IDs, or raw model text.

The **final authorized attempt passed** in 49.64 seconds. It created a fresh
mock three-resistor divider session, set current-limited low-voltage practice
setup, and ran a successful actual local ngspice baseline simulation. It
requested a B-to-GND DC voltage reading, entered `0.275 V` as typed practice
input, completed the readback, and confirmed it. The current evidence was
labelled `simulated_user_input`, not a physical reading. The model-only
capability was denied on confirmation and pause routes.

The app-server accepted a `localImage` input from the controlled E2E practice
UI screenshot `runtime/desktop-verified.png` (1,547,067 bytes on the final
run). The screenshot showed an older `-0.0125 V` SUPPLY practice entry; the
question explicitly identified it as historical illustration unrelated to
the current B reading. The screenshot was refreshed by the root E2E task
between attempts and the final file was visually inspected. It showed only
the Ohm Path practice UI and synthetic data, with disconnected camera panels.
The completed turn proves image input transport, not that the model
interpreted every visual detail. The proof script now freezes a private PNG
snapshot before a turn, passes that immutable copy, and records its SHA-256
in the private report. This snapshot hardening was added after the successful
turn; no additional model turn was run for it.

The runtime requested and received `gpt-6-astra` with medium effort on the
signed-in subscription path. During the completed turn it dispatched the
four required dynamic tools: `get_circuit_graph`, `get_session_evidence`,
`simulate_variant`, and `propose_test`. The session recorded two successful
actual ngspice simulations (baseline and model-requested). Its validated
answer cited the current confirmed practice reading and simulation evidence
using real event IDs, explained that the low B reading does not uniquely
identify R1 versus R2 as high, and linked a proposed A-to-GND DC voltage
test. The proposal did not request or confirm a measurement. The private
final report recorded 407 bounded turn events, 366 text deltas, the four
required tool names, one completed turn, and valid evidence links.

The first two failures remain preserved for audit:

1. `runtime/investigator-proof/event-limit-failure.json` records
   `turn_timeout_or_event_limit`. The old 256-event ceiling counted streamed
   deltas. No event trace was retained, so the exact cause is not proven.
2. `runtime/investigator-proof/forbidden-action-failure.json` records
   `disallowed_model_action_observed`: 71 turn events, 25 deltas, five tool
   requests, and no completed turn. The exact forbidden item type was not
   retained. A duplicate MCP/dynamic tool catalog was a plausible cause,
   not a confirmed diagnosis.

Before the final attempt, the runtime stopped advertising an Ohm Path MCP
server alongside its four dynamic callbacks. Strict configuration disables
inherited MCP servers; a read-only app-server inspection showed only a
built-in `node_repl` entry marked `disabled` with zero tools. The runtime
rejects any active or tool-bearing MCP server and retains fail-closed checks
for shell, file, browser, unknown requests, stale evidence, model reroute,
allowance, stream bounds, and cancellation. The child process now receives
only allowlisted OS/account-path environment variables: bench user/model
capabilities and API keys stay out of its environment. The standalone MCP
proof keeps its original mode. Runtime failures now identify a forbidden
item by a safe type name only, without item content.

This is a **configuration and capability boundary**, not an operating-system
sandbox. The Codex child still runs as the signed-in local user and receives
account-path variables needed for subscription authentication. The app-server
configuration and protocol checks limit what the model can request; they do
not establish that the process lacks OS-level file access. Physical actions
remain outside this proof and require separate hardware safety acceptance.

Validation: the final proof command
`.venv/Scripts/python.exe scripts/prove-investigator.py --authorized-live-proof`
exited 0. Its private aggregate report is
`runtime/investigator-proof/latest-report.json`. AI regression checks after
the boundary changes: 30 passed, with one existing Starlette deprecation
warning. The proof script compiled. This was a mock practice and actual
local simulation test, **not a physical circuit or hardware acceptance test**.

Changed paths: `services/bench/src/ohmpath/ai/runtime.py`,
`services/bench/src/ohmpath/ai/live_proof.py`,
`services/bench/tests/test_ai_runtime.py`, `scripts/prove-investigator.py`,
and this file. No contract change. Remaining verification: production UI
invocation and hardware/physical acceptance are separate gates. Proposed
plain-English commit title: `Restrict investigator tools and verify the practice reasoning loop`.
