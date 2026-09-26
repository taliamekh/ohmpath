# KiCad and ngspice readiness

Checked September 26, 2026 on the prepared Windows development checkout. This records a local software integration check; it does not establish physical circuit behavior.

## Installed tools and actual result

- KiCad CLI **10.0.6** was found at the configured per-user KiCad 10 location. The reviewed `fixtures/circuits/kicad/passive-source.kicad_sch` exported successfully as KiCad XML.
- The import produced `R1`, a 10 kΩ resistor, and `V1`, a 3.3 V DC source, connected between `SUPPLY_d77c7c3e` and `GND`.
- ngspice **47** was found at the configured per-user `ngspice_con.exe` location. Running the imported graph through the local operating-point adapter succeeded with exit code 0 and returned **3.300000 V** at the supply node. This is an actual simulator result, not a physical measurement.
- Both bundled comparison fixtures also solved with the installed simulator: `divider` returned A=2.2 V, B=1.1 V and SUPPLY=3.3 V; `loaded-divider` returned P=3.0 V, Q=3.0 V and SUPPLY=3.3 V. These match their independent hand-calculated references within the test tolerance.

## Bounds and rejected inputs

The adapters select fixed local executables, pass argument arrays without a shell, generate the only supported passive DC operating-point deck themselves, and bound run time and captured logs. KiCad imports accept only the reviewed resistor and DC source library identities and pin maps. Simulator directives, external XML entities, malformed or unsupported structures, duplicate or invalid pins/nets, uncurated parts, hierarchy, and paths outside the approved source root are rejected by the current tests.

The KiCad adapter now monitors the XML export while the process runs and terminates KiCad if the file grows past the 5 MB import limit. Previously, that limit was checked only after process completion.

## Verification run

`.venv/Scripts/python.exe -m pytest services/bench/tests/test_circuits_kicad.py services/bench/tests/test_circuits.py -q` completed with **31 passed**. This included real KiCad export, import-to-ngspice execution, and the two golden passive fixtures, plus invalid-import and export-size-bound checks. No test failures occurred.

`.venv/Scripts/python.exe -m ruff check services/bench/src/ohmpath/circuits/kicad.py services/bench/src/ohmpath/circuits/simulation.py services/bench/tests/test_circuits.py services/bench/tests/test_circuits_kicad.py` completed with **All checks passed**.

## Remaining verification

This remains a narrow passive-circuit path. It does not import arbitrary KiCad projects, hierarchical sheets, external models, or arbitrary SPICE commands; it does not classify ERC warnings, show an exported schematic image, or prove that physical wiring matches the schematic. The existing KiCad handoff records an ERC result of 0 errors and 2 library-registration warnings; that ERC was not rerun in this check. A user must still review those warnings and, separately, supervise any physical measurement. No circuit was energized and no hardware test was performed here.

The executable lookup is intentionally tied to the configured per-user Windows installation in this build. A different KiCad/ngspice installation layout requires an explicitly reviewed configuration change; the adapters do not silently select an alternate KiCad binary.
