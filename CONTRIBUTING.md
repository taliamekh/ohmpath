# Working on Ohm Path

## Names and organization

Use **Ohm Path** in the interface and prose; use `ohmpath` for package names and identifiers where spaces are unsuitable. Do not rename the existing local workspace or historical files just to remove the old name.

Keep application UI in `apps/desktop`, laptop services in `services/bench`, Pi code in `services/pi`, shared schemas in `packages/contracts`, curated hardware in `hardware`, sanitized fixtures in `fixtures`, and documentation in `docs`. See the [specification](docs/hackathon-build/spec.md#planned-file-structure) and current README for implemented capabilities and remaining verification.

Use descriptive lowercase hyphenated documentation filenames. New CAD exports should have a readable part name and revision, with one manifest naming the current assembly. Keep source designs separate from exports, pictures, and manufacturing files. Do not scatter screenshots, temporary scripts, or alternative "final" versions in the root.

## Every commit must be understandable

Write a short plain-English title that describes the actual change. Do not prefix it with task codes, issue numbers, or labels such as `feat:`, `fix:`, or `chore:`. Internal task identifiers may be referenced in the body, never substituted for the title.

Good titles:

- `Document the Ohm Path build plan`
- `Connect Ohm Path to the signed-in Codex account`
- `Compare confirmed meter readings with circuit simulations`
- `Let users report measurements by voice`
- `Stop the pointer when camera calibration becomes stale`
- `Add the first animated circuit guide`

Avoid titles such as `WIP`, `Updates`, `Task 7`, `Fix stuff`, or `Final version`.

One coherent change per commit. In the body explain why it exists, what was verified, and any remaining limitation. Never label a feature complete if only its mock or UI exists. The coordinating agent makes integration commits; subagents report changes without independently committing shared files.

## Before a commit

1. Review exactly the intended files and preserve unrelated user changes.
2. Run the tests appropriate to the affected layer. For documentation, check links and consistency; do not claim application tests ran.
3. Check for secrets, recordings, private account data, local addresses, proprietary circuit material, and unlicensed assets.
4. Check the staged diff for formatting errors and accidental generated files.
5. Use the user's configured author identity. Ask if it is missing; do not invent an email or change global Git identity.

Use `codex/`-prefixed working branches by default. Never force-push or overwrite remote history without explicit authorization. Repository-wide cleanup, licensing, releases, and publishing private evidence require separate review.

## Reviews and verification

Changes involving units, measurement acceptance, power state, calibration, commands, or physical actuation need an independent review. Automated tests do not replace hands-on hardware verification. Record planned targets separately from measured results.

AI costs are shared with the user's account. Keep development agents bounded; use fixtures and mocks for most tests. Do not buy credits, redeem resets, silently change providers, or enable paid fallback.
