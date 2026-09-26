# KiCad passive import handoff

Status: **real KiCad XML export and actual ngspice run passed for one reviewed passive schematic**. This is a narrow electrical import, not a general KiCad project importer or a physical circuit test.

## Changed paths

- `services/bench/src/ohmpath/circuits/kicad.py`: `import_kicad_schematic(path, source_root=...)` is the trusted-file-picker entrypoint. It accepts one `.kicad_sch` inside a resolved approved root, rejects links/junctions, network paths, hierarchical sheets, uncurated library IDs and simulator directives before KiCad runs, then executes the fixed local KiCad 10 CLI with an argument array, temporary output location, timeout and size caps. It parses the real KiCad 10 XML metadata, requires exact `Device:R` or `Simulation_SPICE:VDC` identities and pins, and rejects unsupported tags/structure, XML entities, directives, mismatched source simulation values, duplicate nets and invalid references. The resulting graph revision is based on validated electrical content rather than KiCad's changing export timestamp and absolute source path.
- `fixtures/circuits/kicad/passive-source.kicad_sch`: a reviewed, grid-aligned 3.3 V DC source with a 10 kΩ passive resistor, labeled supply and ground.
- `services/bench/tests/test_circuits_kicad.py`: actual CLI/export and actual ngspice acceptance, plus unsafe/malformed import and pre-export rejections.

## Actual verification

- Installed CLI: `%LOCALAPPDATA%/Programs/KiCad/10.0/bin/kicad-cli.exe`, version **10.0.6**.
- Its `sch export netlist --format kicadxml` output contained R1=10k, V1=3.3, `/SUPPLY`, `/GND`, part/pin metadata, and KiCad 10 `sheetpath`, `tstamps`, `units`, `property`, and `libpart` fields. The reviewed import produced one resistor and one DC source joined at supply/ground; actual ngspice DC operating point returned **3.3 V** at supply. This is simulation evidence, not a measured voltage.
- KiCad ERC reported **0 errors and 2 warnings**. Both warnings were missing library registrations in the current KiCad configuration for `Device` and `Simulation_SPICE`; embedded symbols exported correctly. The fixture's off-grid warnings were removed. Do not claim a clean ERC or silently suppress those library warnings.
- `.venv/Scripts/python.exe -m pytest services/bench/tests/test_circuits_kicad.py services/bench/tests/test_circuits.py -q`: **27 passed**.
- `.venv/Scripts/python.exe -m pytest services/bench/tests -q`: **260 passed**, one upstream FastAPI TestClient deprecation warning.
- `.venv/Scripts/python.exe -m ruff check services/bench/src/ohmpath/circuits/kicad.py services/bench/tests/test_circuits_kicad.py`: **All checks passed**.

## Integration and limits

The coordinator can import `from ohmpath.circuits.kicad import import_kicad_schematic`. The file picker must provide an explicitly reviewed local path and the approved root; do not expose `kicad_cli_path` or `require_library_identity=False` to the model or renderer. `import_kicad_xml` retains a lenient mode for the pre-existing synthetic XML replay tests, while the schematic entrypoint always requires actual curated library identity. The only executable path accepted is the installed KiCad 10 location. The source is preserved; neither KiCad nor the importer overwrites it. KiCad's raw XML contains an absolute source path and export date, so do not publish or log it by default.

No shared contract or dependency manifest changed. This slice does not import arbitrary component families, hierarchical sheets, external model libraries, SPICE directives, negative supplies, SVG diagrams, or ERC acceptance decisions. A trusted user-selected project snapshot, warnings review, versioned import event, and UI integration remain coordinator work. There was no physical test.

Suggested plain-English commit title after coordinator review: `Import reviewed passive KiCad schematics through the bounded local CLI`.
