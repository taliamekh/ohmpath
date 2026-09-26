from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest
from pydantic import ValidationError

from ohmpath.circuits import CircuitGraph, export_kicad_xml, import_kicad_xml, load_fixture, run_operating_point
from ohmpath.circuits.simulation import _resolve_simulator


NGSPICE = _resolve_simulator(None)


@pytest.mark.parametrize(
    ("fixture", "expected"),
    [
        ("divider", {"A": 2.2, "B": 1.1}),
        ("loaded-divider", {"P": 3.0, "Q": 3.0}),
    ],
)
def test_actual_ngspice_matches_independent_hand_calculation(fixture: str, expected: dict[str, float]) -> None:
    if NGSPICE is None:
        pytest.skip("ngspice is not installed; actual solver verification remains pending")
    result = run_operating_point(load_fixture(fixture), simulator_path=NGSPICE)
    assert result.status == "succeeded", result.error or result.stderr
    assert result.provenance == "ngspice_actual"
    assert result.simulator_sha256
    for node, hand_calculated_voltage in expected.items():
        assert result.node_voltages_v[node] == pytest.approx(hand_calculated_voltage, abs=0.002)


def test_graph_rejects_unknown_model_invalid_value_and_missing_ground() -> None:
    payload = json.loads((Path(__file__).parents[3] / "fixtures/circuits/divider.json").read_text())
    payload["components"][1]["model_id"] = "attacker.supplied"
    with pytest.raises(ValidationError):
        CircuitGraph.model_validate_json(json.dumps(payload))

    payload = json.loads((Path(__file__).parents[3] / "fixtures/circuits/divider.json").read_text())
    payload["components"][1]["value_si"] = 0
    with pytest.raises(ValidationError):
        CircuitGraph.model_validate_json(json.dumps(payload))

    payload = json.loads((Path(__file__).parents[3] / "fixtures/circuits/divider.json").read_text())
    payload["ground_nodes"] = ["MISSING"]
    with pytest.raises(ValidationError):
        CircuitGraph.model_validate_json(json.dumps(payload))


def test_unknown_fixture_is_not_resolved_as_a_path() -> None:
    with pytest.raises(ValueError, match="unknown curated"):
        load_fixture("..\\private\\model")


_VALID_XML = b"""<?xml version='1.0'?>
<export><components>
  <comp ref='V1'><value>3.3</value></comp>
  <comp ref='R1'><value>10k</value></comp>
</components><nets>
  <net code='1' name='GND'><node ref='V1' pin='2'/></net>
  <net code='2' name='SUPPLY'><node ref='V1' pin='1'/><node ref='R1' pin='1'/></net>
  <net code='3' name='OUT'><node ref='R1' pin='2'/></net>
</nets></export>"""


def test_kicad_xml_import_normalizes_supported_pin_map() -> None:
    graph = import_kicad_xml(_VALID_XML)
    assert graph.ground_nodes
    assert {component.ref for component in graph.components} == {"V1", "R1"}
    resistor = next(component for component in graph.components if component.ref == "R1")
    assert resistor.value_si == 10_000


@pytest.mark.parametrize(
    "xml",
    [
        _VALID_XML.replace(b"name='GND'", b"name='../../GND'"),
        _VALID_XML.replace(b"<value>10k</value>", b"<value>10k\n.control quit</value>"),
        _VALID_XML.replace(b"ref='R1'", b"ref='X1'"),
        _VALID_XML.replace(b"pin='2'", b"pin='3'"),
        b"<!DOCTYPE foo [<!ENTITY x SYSTEM 'file:///C:/Windows/win.ini'>]><export>&x;</export>",
        _VALID_XML.replace(b"<nets>", b"<nets><command>shell del *</command>"),
    ],
)
def test_kicad_xml_rejects_unsafe_or_unmodeled_imports(xml: bytes) -> None:
    with pytest.raises((ValueError, ValidationError)):
        import_kicad_xml(xml)


def test_kicad_path_must_be_within_approved_root(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    outside = tmp_path / "outside.xml"
    outside.write_bytes(_VALID_XML)
    with pytest.raises(ValueError, match="outside"):
        import_kicad_xml(outside, source_root=source_root)


def test_kicad_export_rejects_path_outside_approved_root(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    outside = tmp_path / "outside.kicad_sch"
    outside.write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match="outside"):
        export_kicad_xml(outside, source_root=source_root)


def test_cancelled_request_does_not_return_successful_values() -> None:
    if NGSPICE is None:
        pytest.skip("ngspice is not installed")
    event = threading.Event()
    event.set()
    result = run_operating_point(load_fixture("divider"), simulator_path=NGSPICE, cancel_event=event)
    assert result.status == "cancelled"
    assert result.node_voltages_v == {}


def test_missing_simulator_is_not_marked_as_actual_execution(tmp_path):
    result = run_operating_point(load_fixture("divider"), simulator_path=tmp_path / "missing.exe")
    assert result.status == "failed" and result.provenance == "none"
    assert result.node_voltages_v == {} and result.exit_code is None


def test_ground_output_does_not_mask_missing_node_voltage():
    from ohmpath.circuits.simulation import _parse_voltages
    with pytest.raises(ValueError, match="omitted requested"):
        _parse_voltages("v(n1) = 2.2\nv(n2) = 1.1\nv(0) = 0\n", load_fixture("divider"))


def test_fatal_solver_output_cannot_produce_success_even_with_exit_zero(tmp_path, monkeypatch):
    import ohmpath.circuits.simulation as simulation
    executable = tmp_path / "mock-solver"
    executable.write_bytes(b"mock test executable identity")
    monkeypatch.setattr(simulation, "_resolve_simulator", lambda _: executable)
    monkeypatch.setattr(simulation, "_version", lambda _: "mock test version")
    class FatalSimulator:
        returncode = 0
        def __init__(self, _args, **kwargs):
            kwargs["stdout"].write(b"Fatal error: failed to converge\nv(n1) = 2.2\nv(n2) = 1.1\nv(n3) = 3.3\n")
        def poll(self):
            return self.returncode
    monkeypatch.setattr(simulation.subprocess, "Popen", FatalSimulator)
    result = simulation.run_operating_point(load_fixture("divider"), work_root=tmp_path / "runs")
    assert result.status == "failed" and result.node_voltages_v == {}
    assert "convergence" in result.error
