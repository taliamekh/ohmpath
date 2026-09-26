# Shared contracts

`schema.json` is the canonical version 1.0.0 schema. Generate bindings with
`python scripts/generate-contracts.py`; verify them using `--check`.

Generated Python bindings enforce structural types. The bench ledger also validates
JSON Schema bounds and UTC date-time formats before persisting an event. Domain
services enforce revisions, dimensional units, single-use confirmations and scopes.
No generated type alone confers authority to accept evidence or operate hardware.
