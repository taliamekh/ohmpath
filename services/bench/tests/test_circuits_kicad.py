"""KiCad 10 XML export acceptance and untrusted-import rejection."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from ohmpath.circuits.kicad import (
    _DEFAULT_KICAD_CLI,
    export_kicad_xml,
    import_kicad_schematic,
    import_kicad_xml,
)
from ohmpath.circuits.simulation import _resolve_simulator, run_operating_point


FIXTURE = Path(__file__).parents[3] / "fixtures/circuits/kicad/passive-source.kicad_sch"


@pytest.fixture(scope="module")
def actual_export() -> bytes:
    if not _DEFAULT_KICAD_CLI.is_file():
        pytest.skip("pinned KiCad 10 CLI unavailable")
    return export_kicad_xml(FIXTURE, source_root=FIXTURE.parent)


def test_installed_kicad_cli_exports_reviewed_passive_source(actual_export: bytes) -> None:
    version = subprocess.run([str(_DEFAULT_KICAD_CLI), "version"], capture_output=True,
                             text=True, timeout=3, check=True)
    assert version.stdout.strip().startswith("10.0.")
    assert b'<comp ref="R1">' in actual_export
    assert b'<comp ref="V1">' in actual_export
    assert b'name="/GND"' in actual_export
    graph = import_kicad_xml(actual_export, require_library_identity=True)
    assert graph.ground_nodes == ("GND",)
    assert {(part.ref, part.value_si) for part in graph.components} == {("R1", 10_000), ("V1", 3.3)}
    assert {part.nodes for part in graph.components} == {("SUPPLY_d77c7c3e", "GND")}


def test_reviewed_schematic_import_reaches_actual_simulator() -> None:
    if not _DEFAULT_KICAD_CLI.is_file():
        pytest.skip("pinned KiCad 10 CLI unavailable")
    ngspice = _resolve_simulator(None)
    if ngspice is None:
        pytest.skip("ngspice unavailable")
    graph = import_kicad_schematic(FIXTURE, source_root=FIXTURE.parent)
    result = run_operating_point(graph, simulator_path=ngspice)
    assert result.status == "succeeded", result.error or result.stderr
    assert result.provenance == "ngspice_actual"
    supply = next(node for node in result.node_voltages_v if node.startswith("SUPPLY_"))
    assert result.node_voltages_v[supply] == pytest.approx(3.3, abs=0.002)


def test_export_timestamp_and_path_do_not_change_electrical_revision(actual_export: bytes) -> None:
    original = import_kicad_xml(actual_export, require_library_identity=True)
    changed_metadata = actual_export.replace(b"<date>2026-", b"<date>2099-", 1)
    changed_metadata = changed_metadata.replace(b"passive-source.kicad_sch</source>",
                                                b"different-name.kicad_sch</source>", 1)
    assert changed_metadata != actual_export
    assert import_kicad_xml(changed_metadata, require_library_identity=True).revision == original.revision


@pytest.mark.parametrize("old,new", [
    (b'lib="Device" part="R"', b'lib="Device" part="C"'),
    (b'<value>10k</value>', b'<value>10k .control quit</value>'),
    (b'dc(3.3)', b'dc(3.3) ; .include ../other.lib'),
    (b'<value>3.3</value>', b'<value>300</value>'),
    (b'<pin num="2" name="" type="passive"/>', b'<pin num="3" name="" type="passive"/>'),
    (b'<node ref="V1" pin="2"', b'<node ref="V1" pin="3"'),
    (b'<net code="2"', b'<net code="1"'),
    (b'<components>', b'<components><command>shell</command>'),
])
def test_real_export_mutations_are_rejected(actual_export: bytes, old: bytes, new: bytes) -> None:
    assert old in actual_export
    with pytest.raises(ValueError):
        import_kicad_xml(actual_export.replace(old, new, 1), require_library_identity=True)


def test_external_entity_and_legacy_identity_are_rejected(actual_export: bytes) -> None:
    entity_xml = actual_export.replace(b"?>", b"?>\n<!DOCTYPE export [<!ENTITY z SYSTEM "
                                      b"'file:///C:/Windows/win.ini'>]>", 1)
    entity_xml = entity_xml.replace(b"<value>10k</value>", b"<value>&z;</value>", 1)
    with pytest.raises(ValueError):
        import_kicad_xml(entity_xml, require_library_identity=True)
    without_identity = actual_export.replace(b'<libsource lib="Device" part="R" description=""/>', b'')
    with pytest.raises(ValueError, match="library identity"):
        import_kicad_xml(without_identity, require_library_identity=True)


def test_export_rejects_hierarchy_and_alternate_executable(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    candidate = source / "rejected.kicad_sch"
    candidate.write_text(FIXTURE.read_text(encoding="utf-8").replace(
        "(sheet_instances", '(sheet (property "Sheetfile" "../../secret.kicad_sch"))\n  (sheet_instances'),
        encoding="utf-8")
    with pytest.raises(ValueError, match="hierarchical"):
        export_kicad_xml(candidate, source_root=source)
    candidate.write_text(FIXTURE.read_text(encoding="utf-8").replace(
        '(lib_id "Device:R")', '(lib_id "Untrusted:Device")'), encoding="utf-8")
    with pytest.raises(ValueError, match="uncurated"):
        export_kicad_xml(candidate, source_root=source)
    candidate.write_text(FIXTURE.read_text(encoding="utf-8").replace(
        '(property "Value" "10k"', '(property "Value" ".include hidden.lib"'), encoding="utf-8")
    with pytest.raises(ValueError, match="directives"):
        export_kicad_xml(candidate, source_root=source)
    with pytest.raises(ValueError, match="pinned KiCad"):
        export_kicad_xml(FIXTURE, source_root=FIXTURE.parent, kicad_cli_path=tmp_path / "kicad-cli.exe")
