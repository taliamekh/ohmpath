from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")


class CircuitComponent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    ref: str = Field(min_length=1, max_length=32)
    kind: Literal["resistor", "dc_voltage_source"]
    nodes: tuple[str, str]
    value_si: float = Field(ge=0.0, le=1e12)
    model_id: Literal["ohmpath.resistor.v1", "ohmpath.dc_source.v1"]

    @model_validator(mode="after")
    def validate_model_and_value(self) -> "CircuitComponent":
        if not _IDENTIFIER.fullmatch(self.ref):
            raise ValueError("component reference must be a simple identifier")
        if any(not _IDENTIFIER.fullmatch(node) for node in self.nodes):
            raise ValueError("node names must be simple identifiers")
        if self.nodes[0] == self.nodes[1]:
            raise ValueError("component terminals must connect to distinct nodes")
        expected = {
            "resistor": "ohmpath.resistor.v1",
            "dc_voltage_source": "ohmpath.dc_source.v1",
        }[self.kind]
        if self.model_id != expected:
            raise ValueError("component model does not match its registered kind")
        if not math.isfinite(self.value_si):
            raise ValueError("component value must be finite")
        if self.kind == "resistor" and self.value_si <= 0:
            raise ValueError("resistance must be greater than zero")
        required_prefix = "R" if self.kind == "resistor" else "V"
        if not self.ref.startswith(required_prefix):
            raise ValueError(f"{self.kind} references must start with {required_prefix}")
        return self


class CircuitGraph(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    circuit_id: str = Field(min_length=1, max_length=64)
    revision: str = Field(min_length=1, max_length=64)
    ground_nodes: tuple[str, ...] = Field(min_length=1)
    components: tuple[CircuitComponent, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_graph(self) -> "CircuitGraph":
        if not _IDENTIFIER.fullmatch(self.circuit_id) or not _IDENTIFIER.fullmatch(self.revision):
            raise ValueError("circuit and revision IDs must be simple identifiers")
        if len(set(self.ground_nodes)) != len(self.ground_nodes):
            raise ValueError("ground nodes must be unique")
        if any(not _IDENTIFIER.fullmatch(node) for node in self.ground_nodes):
            raise ValueError("ground node names must be simple identifiers")
        refs = [component.ref for component in self.components]
        if len({ref.casefold() for ref in refs}) != len(refs):
            raise ValueError("component references must be unique")
        all_nodes = {node for component in self.components for node in component.nodes}
        if not set(self.ground_nodes).issubset(all_nodes):
            raise ValueError("every ground node must be connected to a component")
        if not any(component.kind == "dc_voltage_source" for component in self.components):
            raise ValueError("a DC operating point requires a voltage source")
        return self

    @property
    def graph_sha256(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class SimulationResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    simulation_id: str
    status: Literal["succeeded", "failed", "cancelled", "timed_out"]
    provenance: Literal["ngspice_actual"]
    graph_sha256: str
    netlist_sha256: str
    simulator_sha256: str | None
    simulator_version: str | None
    node_voltages_v: dict[str, float] = Field(default_factory=dict)
    exit_code: int | None
    duration_s: float
    stdout: str
    stderr: str
    netlist: str
    error: str | None = None
