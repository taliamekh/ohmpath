from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Literal, Mapping

from .models import CircuitGraph


_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$")
_ACK_TYPES = {"reported_done", "visual_inspection", "continuity_verified"}
_Action = Literal["power_check", "place_component", "inspect", "continuity_check"]


@dataclass(frozen=True)
class AssemblyStep:
    step_id: str
    order: int
    action: _Action
    instruction: str
    component_ref: str | None = None
    pin_holes: tuple[tuple[str, str], ...] = ()
    node_ids: tuple[str, ...] = ()
    prerequisites: tuple[str, ...] = ("power_disconnected",)
    completion_evidence: tuple[str, ...] = ("explicit_user_acknowledgment",)


@dataclass(frozen=True)
class AssemblyPlan:
    plan_id: str
    circuit_id: str
    circuit_revision: str
    layout_revision: str
    board_template_id: str
    required_power_state: Literal["disconnected"]
    step_ids: tuple[str, ...]
    steps: tuple[AssemblyStep, ...]
    graph_equivalent: bool
    physically_verified: bool = False


@dataclass(frozen=True)
class AssemblyAcknowledgment:
    step_id: str
    evidence_kind: Literal["reported_done", "visual_inspection", "continuity_verified"]
    acknowledged_by: str
    evidence_ref: str | None = None
    occurred_at: str | None = None
    electrically_verified: bool = False


def build_assembly_plan(
    graph: CircuitGraph,
    terminal_holes: Mapping[str, str],
    *,
    board_template_id: str,
    layout_revision: str,
    hole_groups: Mapping[str, str],
) -> AssemblyPlan:
    """Create a deterministic, power-off placement sequence from a validated graph.

    The caller supplies an accepted pin-to-hole map and verified template connectivity
    groups. This planner does not infer physical holes from pixels or invent a board map.
    """
    for label, value in (("board_template_id", board_template_id), ("layout_revision", layout_revision)):
        if not isinstance(value, str) or not _ID.fullmatch(value):
            raise ValueError(f"invalid {label}")
    expected_pins = {f"{component.ref}.{index}" for component in graph.components for index in (1, 2)}
    if set(terminal_holes) != expected_pins:
        missing, extra = expected_pins - set(terminal_holes), set(terminal_holes) - expected_pins
        raise ValueError(f"terminal map mismatch; missing={sorted(missing)}, extra={sorted(extra)}")
    if not hole_groups:
        raise ValueError("verified board connectivity groups are required")

    occupied: dict[str, str] = {}
    node_to_group: dict[str, str] = {}
    group_to_node: dict[str, str] = {}
    pin_map: dict[str, tuple[str, str]] = {}
    for component in graph.components:
        for index, node_id in enumerate(component.nodes, start=1):
            pin = f"{component.ref}.{index}"
            hole = terminal_holes[pin]
            group = hole_groups.get(hole)
            if not _ID.fullmatch(hole) or group is None or not _ID.fullmatch(group):
                raise ValueError(f"unknown or invalid board hole for {pin}")
            if hole in occupied:
                raise ValueError(f"board hole {hole!r} is assigned more than once")
            occupied[hole] = pin
            if node_id in node_to_group and node_to_group[node_id] != group:
                raise ValueError(f"net {node_id!r} is split across board connectivity groups")
            if group in group_to_node and group_to_node[group] != node_id:
                raise ValueError(f"distinct nets {group_to_node[group]!r} and {node_id!r} are shorted")
            node_to_group[node_id] = group
            group_to_node[group] = node_id
            pin_map[pin] = (hole, node_id)

    steps: list[AssemblyStep] = []

    def add_step(action: _Action, instruction: str,
                 *, ref: str | None = None, pins: tuple[tuple[str, str], ...] = (),
                 nodes: tuple[str, ...] = (), evidence: tuple[str, ...] = ("explicit_user_acknowledgment",)) -> None:
        order = len(steps) + 1
        stable = json.dumps([graph.graph_sha256, layout_revision, board_template_id, order, action, ref, pins],
                            sort_keys=True, separators=(",", ":"))
        step_id = "asm-" + hashlib.sha256(stable.encode("utf-8")).hexdigest()[:16]
        steps.append(AssemblyStep(step_id, order, action, instruction, ref, pins, nodes,
                                  ("power_disconnected",), evidence))

    add_step("power_check", "Confirm the supply is disconnected and keep both supply leads separated.",
             evidence=("explicit_user_acknowledgment",))
    for component in graph.components:
        pair = tuple((f"pin{index}", pin_map[f"{component.ref}.{index}"][0]) for index in (1, 2))
        node_ids = tuple(component.nodes)
        value = f"{component.value_si:g} Ω" if component.kind == "resistor" else f"{component.value_si:g} V DC"
        add_step("place_component",
                 f"Place {component.ref} ({component.kind}, {value}) with pin 1 at {pair[0][1]} on net {node_ids[0]} and pin 2 at {pair[1][1]} on net {node_ids[1]}.",
                 ref=component.ref, pins=pair, nodes=node_ids)
    add_step("inspect", "With power still disconnected, inspect every listed placement and check source polarity against the board pin map.",
             evidence=("explicit_user_acknowledgment", "visual_inspection"))
    add_step("continuity_check", "With power disconnected, continuity-check each intended net and check that distinct nets are not shorted.",
             evidence=("explicit_user_acknowledgment", "continuity_observation"))

    identity = json.dumps([graph.graph_sha256, layout_revision, board_template_id,
                           [(key, terminal_holes[key]) for key in sorted(terminal_holes)]],
                          separators=(",", ":"))
    return AssemblyPlan(
        plan_id="assembly-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20],
        circuit_id=graph.circuit_id, circuit_revision=graph.revision,
        layout_revision=layout_revision, board_template_id=board_template_id,
        required_power_state="disconnected", step_ids=tuple(step.step_id for step in steps),
        steps=tuple(steps), graph_equivalent=True, physically_verified=False,
    )


def acknowledge_assembly_step(
    plan: AssemblyPlan,
    step_id: str,
    *,
    evidence_kind: Literal["reported_done", "visual_inspection", "continuity_verified"],
    acknowledged_by: str,
    evidence_ref: str | None = None,
    occurred_at: str | None = None,
) -> AssemblyAcknowledgment:
    """Record a user-supplied observation; this never mutates plan verification state."""
    if step_id not in plan.step_ids:
        raise ValueError("acknowledgment references an unknown assembly step")
    if evidence_kind not in _ACK_TYPES:
        raise ValueError("unsupported assembly acknowledgment type")
    if not _ID.fullmatch(acknowledged_by):
        raise ValueError("acknowledged_by must identify the user or evidence source")
    if evidence_ref is not None and not _ID.fullmatch(evidence_ref):
        raise ValueError("invalid evidence reference")
    step = next(step for step in plan.steps if step.step_id == step_id)
    if evidence_kind == "continuity_verified" and step.action != "continuity_check":
        raise ValueError("continuity verification can only acknowledge a continuity check")
    # An arbitrary evidence reference is not a validated measurement ledger entry.
    # This record preserves what was reported without promoting it to verification.
    return AssemblyAcknowledgment(step_id, evidence_kind, acknowledged_by, evidence_ref, occurred_at,
                                  electrically_verified=False)


def logical_assembly_guide(graph: CircuitGraph, circuit_revision: str) -> dict:
    """Connection-level guidance when no physical board template is accepted."""
    steps = []
    def add(title, instruction, components=(), nodes=()):
        identity = json.dumps([graph.graph_sha256, circuit_revision, title, components, nodes])
        steps.append({"step_id": "logic-" + hashlib.sha256(identity.encode()).hexdigest()[:16],
                      "title": title, "instruction": instruction, "component_ids": list(components),
                      "node_ids": list(nodes), "requires_unpowered": True})
    add("Disconnect power", "Disconnect all power sources, verify discharged storage, and keep the supply leads separated. This guide does not authorize energizing the circuit.")
    for component in graph.components:
        if component.kind == "resistor":
            add(f"Check {component.ref}", f"Identify {component.ref} ({component.value_si:g} ohm). Its two terminals belong to nodes {component.nodes[0]} and {component.nodes[1]}. Confirm the board layout before choosing physical holes.", (component.ref,), component.nodes)
        else:
            add(f"Review {component.ref} polarity", f"The model defines {component.ref} as {component.value_si:g} V DC, positive at {component.nodes[0]} and negative at {component.nodes[1]}. Leave it disconnected during assembly.", (component.ref,), component.nodes)
    add("Inspect connections", "With power disconnected, compare every connection with the accepted graph. Physical hole mapping has not been verified.")
    add("Plan continuity checks", "With power disconnected and stored energy discharged, verify intended net connections and isolation using the separate measurement readback workflow. Self-reported completion is not an electrical verification.")
    return {"mode": "guidance", "circuit_revision": circuit_revision, "steps": steps,
            "physical_verification": "pending", "layout_status": "physical_template_pending"}
