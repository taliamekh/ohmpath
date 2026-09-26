from __future__ import annotations

from collections import defaultdict

import pytest

from ohmpath.circuits import load_fixture
from ohmpath.circuits.assembly import acknowledge_assembly_step, build_assembly_plan


def layout_for(graph):
    terminals = {}
    groups = {}
    node_counts = defaultdict(int)
    for component in graph.components:
        for pin, node in enumerate(component.nodes, start=1):
            node_counts[node] += 1
            hole = f"main_board:left:a:{node_counts[node]}-{node}"
            terminals[f"{component.ref}.{pin}"] = hole
            groups[hole] = f"net-{node}"
    return terminals, groups


@pytest.mark.parametrize("fixture", ["divider", "loaded-divider"])
def test_graph_assembly_plan_is_electrically_equivalent_and_requires_unpowered_user_steps(fixture):
    graph = load_fixture(fixture)
    terminals, groups = layout_for(graph)
    plan = build_assembly_plan(graph, terminals, board_template_id="verified-template-v1",
                               layout_revision="layout-r1", hole_groups=groups)
    assert plan.graph_equivalent is True
    assert plan.physically_verified is False
    assert plan.required_power_state == "disconnected"
    assert len(plan.step_ids) == len(plan.steps) == len(set(plan.step_ids))
    assert plan.steps[0].action == "power_check"
    assert all("power_disconnected" in step.prerequisites for step in plan.steps)
    assert {step.component_ref for step in plan.steps if step.action == "place_component"} == {
        component.ref for component in graph.components
    }
    assert build_assembly_plan(graph, terminals, board_template_id="verified-template-v1",
                               layout_revision="layout-r1", hole_groups=groups).step_ids == plan.step_ids
    with pytest.raises(ValueError, match="unknown assembly step"):
        acknowledge_assembly_step(plan, "not-a-step", evidence_kind="reported_done", acknowledged_by="user")
    continuity = next(step for step in plan.steps if step.action == "continuity_check")
    ack = acknowledge_assembly_step(plan, continuity.step_id, evidence_kind="continuity_verified",
                                    acknowledged_by="user", evidence_ref="continuity-note-1")
    assert ack.electrically_verified is False
    done = acknowledge_assembly_step(plan, plan.steps[1].step_id, evidence_kind="reported_done", acknowledged_by="user")
    assert done.electrically_verified is False
    assert plan.physically_verified is False


def test_assembly_rejects_missing_pin_split_net_short_and_occupied_hole():
    graph = load_fixture("divider")
    terminals, groups = layout_for(graph)
    args = dict(board_template_id="verified-template-v1", layout_revision="layout-r1")
    with pytest.raises(ValueError, match="terminal map mismatch"):
        build_assembly_plan(graph, {**terminals, "R9.1": "hole-extra"}, hole_groups=groups, **args)

    split = dict(groups)
    shared_node_hole = terminals["V1.1"]
    split[shared_node_hole] = "wrong-group"
    with pytest.raises(ValueError, match="split across"):
        build_assembly_plan(graph, terminals, hole_groups=split, **args)

    short = dict(groups)
    short_group = "net-SUPPLY"
    for component in graph.components:
        for pin, node in enumerate(component.nodes, start=1):
            if node in {"SUPPLY", "A"}:
                short[terminals[f"{component.ref}.{pin}"]] = short_group
    with pytest.raises(ValueError, match="shorted"):
        build_assembly_plan(graph, terminals, hole_groups=short, **args)

    collision = dict(terminals)
    collision["R1.1"] = collision["V1.1"]
    with pytest.raises(ValueError, match="assigned more than once"):
        build_assembly_plan(graph, collision, hole_groups=groups, **args)
