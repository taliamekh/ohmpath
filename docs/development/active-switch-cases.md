# Educational active-switch fault cases

This is a bounded simulator fixture for a 3.3 V low-side NMOS switch with a
1 kΩ load, a 100 kΩ gate pulldown, and a fixed level-1 model. It broadens
the earlier resistor, RC, and diode examples with an active device and five
named cases: healthy, gate disconnected, load open, device open, and device
shorted. Each case is solved at drive low and drive high by the installed
ngspice executable. Gate voltage, drain voltage, and supply current give
distinct signatures across those two states in the fixture tests.

`services/bench/src/ohmpath/circuits/active_switch.py` generates the whole
netlist from fixed code. The caller can only choose one of the five case
names; untrusted text cannot add a component, model, simulator directive, or
shell command. It uses the existing bounded laboratory runner and returns
the simulator identity, netlist hash, actual-simulation provenance, raw logs,
status, and numerical points. A missing or failing simulator returns no
points. The expected signatures and declared thresholds live in
`fixtures/circuits/active-switch-cases.json`.

The open and short conditions use finite resistor proxies. A fixed 100 MΩ
drain leakage path defines voltage when the load is open; without it the
node floats and its apparent voltage is not a reliable fault signature.
The transistor model is educational, not a model of a specific part. These
results are simulations; they are not confirmed measurements, a physical
diagnosis, a wiring instruction, or permission to power hardware. The new
case is not connected to the desktop laboratory menu or the canonical
session contract yet. Integrating it there requires coordinated API and UI
ownership, plus independent electrical review.

## Verification

- Actual ngspice: all five named cases solved; their two-state gate, drain,
  and current signatures matched the reviewed fixture and were distinct.
- Targeted regressions: **44 passed** across the active switch, existing
  laboratory, circuit, assembly, and diagnosis tests.
- Full bench-service suite: **433 passed, 2 skipped**, with one existing
  Starlette/httpx deprecation warning.
- Ruff check on the new Python module and test: **passed**.
- No physical circuit, meter, MCU, camera, motor, or laser was operated.

## Remaining gates

- Select an actual transistor and a reviewed model, then compare predicted
  and measured operation with stated supply, load, temperature, and meter
  uncertainty before applying this case to a physical board.
- Complete a human-reviewed breadboard template and powered-off connection
  check for the actual breadboard; the software fixture has no hole map.
- Select the exact MCU board and deployed firmware identity for the separate
  firmware-versus-hardware case. No board is selected by this fixture.
- Extend the coordinator-owned API, contracts, and UI after a file handoff.
