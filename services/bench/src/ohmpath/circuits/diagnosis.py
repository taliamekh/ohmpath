from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any

from .models import CircuitComponent, CircuitGraph, SimulationResult
from .simulation import run_operating_point


MAX_RESISTORS = 6
MAX_VARIANTS = 24
MAX_READINGS = 12
MAX_TEST_PAIRS = 16
MAX_RUNTIME_S = 15.0
_SIMULATION_SCHEDULING_BUDGET_S = MAX_RUNTIME_S - 3.0
MAX_RUN_S = 0.75
METER_INPUT_RESISTANCE_OHM = 10_000_000.0
OPEN_PROXY_OHM = 1_000_000_000_000.0
BYPASS_PROXY_OHM = 0.000001


def _comparison_band(measured_v: float, predicted_v: float) -> float:
    """Provisional absolute/relative screening band; not a statistical tolerance interval."""
    return max(0.05, 0.10 * abs(measured_v), 0.10 * abs(predicted_v))


def _validate_readings(graph: CircuitGraph, readings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(readings, list) or len(readings) > MAX_READINGS:
        raise ValueError(f"readings must be a list of at most {MAX_READINGS} confirmed values")
    nodes = {node for item in graph.components for node in item.nodes}
    normalized: list[dict[str, Any]] = []
    evidence_ids: set[str] = set()
    for index, reading in enumerate(readings):
        if not isinstance(reading, dict) or set(reading) != {"red_node_id", "black_node_id", "value_v", "evidence_id"}:
            raise ValueError(f"reading {index} must contain exactly red_node_id, black_node_id, value_v, evidence_id")
        red, black, evidence_id, value = (reading[k] for k in ("red_node_id", "black_node_id", "evidence_id", "value_v"))
        if not isinstance(red, str) or not isinstance(black, str) or red not in nodes or black not in nodes:
            raise ValueError(f"reading {index} references a node outside this graph")
        if red == black:
            raise ValueError(f"reading {index} must use distinct probe nodes")
        if not isinstance(evidence_id, str) or not evidence_id.strip() or len(evidence_id) > 128:
            raise ValueError(f"reading {index} requires a bounded evidence_id")
        if evidence_id in evidence_ids:
            raise ValueError("confirmed readings must have unique evidence IDs")
        evidence_ids.add(evidence_id)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e12:
            raise ValueError(f"reading {index} value_v must be a finite signed voltage within ±1e12 V")
        normalized.append({"red_node_id": red, "black_node_id": black, "value_v": float(value),
                           "evidence_id": evidence_id})
    return normalized


def _replace_component(graph: CircuitGraph, ref: str, value: float) -> CircuitGraph:
    replaced = tuple(
        CircuitComponent(ref=item.ref, kind=item.kind, nodes=item.nodes, value_si=value if item.ref == ref else item.value_si,
                         model_id=item.model_id)
        for item in graph.components
    )
    return CircuitGraph(circuit_id=graph.circuit_id, revision=graph.revision,
                        ground_nodes=graph.ground_nodes, components=replaced)


def _add_meter(graph: CircuitGraph, red_node: str, black_node: str) -> CircuitGraph:
    refs = {component.ref.casefold() for component in graph.components}
    index = 1
    while f"RZ{index}".casefold() in refs:
        index += 1
    if index > 999:
        raise ValueError("no safe resistor reference is available for the input-meter model")
    meter = CircuitComponent(ref=f"RZ{index}", kind="resistor", nodes=(red_node, black_node),
                             value_si=METER_INPUT_RESISTANCE_OHM, model_id="ohmpath.resistor.v1")
    return CircuitGraph(circuit_id=graph.circuit_id, revision=graph.revision,
                        ground_nodes=graph.ground_nodes, components=graph.components + (meter,))


def _fault_variants(graph: CircuitGraph) -> list[tuple[str, str, CircuitGraph, tuple[str, ...]]]:
    resistors = [item for item in graph.components if item.kind == "resistor"]
    sources = [item for item in graph.components if item.kind == "dc_voltage_source"]
    if len(resistors) > MAX_RESISTORS:
        raise ValueError(f"the diagnosis profile supports at most {MAX_RESISTORS} resistors")
    if len(sources) != 1:
        raise ValueError("the diagnosis profile requires exactly one independent DC source")

    variants: list[tuple[str, str, CircuitGraph, tuple[str, ...]]] = [
        ("healthy", "Healthy values as drawn", graph, ("supported source/resistor models",))
    ]
    for resistor in resistors:
        high_value = max(resistor.value_si * 10, 100_000.0)
        values = (
            ("high", high_value, f"{resistor.ref} high-path case ({high_value:g} Ω)",
             "high-path resistance is modeled as max(10× nominal, 100 kΩ); this can represent a resistive contact/jumper surrogate and does not identify a failed component"),
            ("open-proxy", OPEN_PROXY_OHM, f"{resistor.ref} open (1 TΩ proxy)", "open circuit is approximated by 1 TΩ; it is not an ideal open"),
            ("bypass-proxy", BYPASS_PROXY_OHM, f"{resistor.ref} bypassed (1 µΩ proxy)", "bypass is approximated by 1 µΩ; it is not an ideal short"),
        )
        seen_values = {resistor.value_si}
        for label, value, title, assumption in values:
            if value > 1e12 or value <= 0 or value in seen_values:
                continue
            seen_values.add(value)
            variant_id = f"{resistor.ref}-{label}"
            variants.append((variant_id, title, _replace_component(graph, resistor.ref, value), (assumption,)))
    source = sources[0]
    variants.append(("source-off", "DC source off (0 V)", _replace_component(graph, source.ref, 0.0),
                     ("source-off means the modeled independent source is set to 0 V",)))
    if len(variants) > MAX_VARIANTS:
        raise ValueError(f"fault library exceeds the {MAX_VARIANTS}-variant execution bound")
    return variants


def _node_voltage(node_id: str, graph: CircuitGraph, result: SimulationResult) -> float:
    if node_id in graph.ground_nodes:
        return 0.0
    return result.node_voltages_v[node_id]


def _result_evidence(result: SimulationResult, *, variant_id: str,
                     red_node_id: str, black_node_id: str) -> dict[str, Any]:
    record = result.model_dump(mode="json")
    record.update({"variant_id": variant_id, "meter_red_node_id": red_node_id,
                   "meter_black_node_id": black_node_id,
                   "meter_input_resistance_ohm": METER_INPUT_RESISTANCE_OHM})
    return record


def diagnose_circuit(graph: CircuitGraph, readings: list[dict[str, Any]], *, work_root: Path) -> dict[str, Any]:
    """Compare bounded resistor/source hypotheses using actual ngspice only.

    Readings are presumed confirmed for ``graph.revision`` by the caller. Every returned
    prediction is tied to a successful actual ngspice result; missing/failed runs have no
    numeric prediction. This intentionally does not infer connectivity or physical causes.
    """
    if not isinstance(work_root, Path):
        raise TypeError("work_root must be a pathlib.Path")
    normalized_readings = _validate_readings(graph, readings)
    variants = _fault_variants(graph)
    nodes = sorted({node for component in graph.components for node in component.nodes})
    reference = graph.ground_nodes[0]

    pair_order: list[tuple[str, str]] = []
    for reading in normalized_readings:
        pair = (reading["red_node_id"], reading["black_node_id"])
        if pair not in pair_order:
            pair_order.append(pair)
    measured_pairs_unordered = {frozenset((item["red_node_id"], item["black_node_id"])) for item in normalized_readings}
    for node in nodes:
        if node == reference or frozenset((node, reference)) in measured_pairs_unordered:
            continue
        pair = (node, reference)
        if pair not in pair_order:
            pair_order.append(pair)
    pair_budget_trimmed = len(pair_order) > MAX_TEST_PAIRS
    pair_order = pair_order[:MAX_TEST_PAIRS]

    # Reserve up to three seconds for a bounded ngspice version probe and final child cleanup.
    deadline = time.monotonic() + _SIMULATION_SCHEDULING_BUDGET_S
    simulation_records: list[dict[str, Any]] = []
    results_by_pair: dict[tuple[str, str], dict[str, SimulationResult]] = {pair: {} for pair in pair_order}
    skipped_pairs: set[tuple[str, str]] = set()
    limitations = [
        "Comparison band is provisional: max(50 mV, 10% of the measured or predicted magnitude); it is not a validated statistical uncertainty interval.",
        "Predictions use an assumed ideal 10 MΩ DC meter input across the named probes and the nominal graph values; actual meter loading, component tolerance, supply uncertainty and repeatability are not characterized.",
        "High resistance is modeled as 10× nominal; open is a 1 TΩ proxy; bypass is a 1 µΩ proxy. These are modeled fault scenarios, not proof of a physical defect.",
        "A consistent hypothesis is only a candidate. This profile cannot distinguish a component defect from a contact, wiring, or model error without further evidence.",
        "The unknown-or-combined-fault hypothesis is explicit and has no fabricated numeric predictions.",
    ]

    for variant_id, title, variant_graph, assumptions in variants:
        for pair in pair_order:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                skipped_pairs.add(pair)
                continue
            red, black = pair
            try:
                meter_graph = _add_meter(variant_graph, red, black)
            except ValueError as exc:
                limitations.append(str(exc))
                skipped_pairs.add(pair)
                continue
            result = run_operating_point(meter_graph, timeout_s=min(MAX_RUN_S, max(0.05, remaining)),
                                         work_root=work_root)
            simulation_records.append(_result_evidence(result, variant_id=variant_id,
                                                       red_node_id=red, black_node_id=black))
            if result.status == "succeeded":
                results_by_pair[pair][variant_id] = result
            else:
                limitations.append(f"{variant_id} at red {red}/black {black}: ngspice {result.status}: {result.error or result.stderr[:300]}")

    hypothesis_records: list[dict[str, Any]] = []
    predictions_by_variant_pair: dict[str, dict[tuple[str, str], dict[str, float]]] = {}
    for variant_id, title, variant_graph, assumptions in variants:
        comparisons: list[dict[str, Any]] = []
        support: list[str] = []
        contradictions: list[str] = []
        for reading in normalized_readings:
            pair = (reading["red_node_id"], reading["black_node_id"])
            result = results_by_pair.get(pair, {}).get(variant_id)
            if result is None:
                continue
            try:
                predicted = _node_voltage(reading["red_node_id"], variant_graph, result) - _node_voltage(
                    reading["black_node_id"], variant_graph, result)
            except KeyError:
                continue
            measured = reading["value_v"]
            band = _comparison_band(measured, predicted)
            matched = abs(measured - predicted) <= band
            comparisons.append({"evidence_id": reading["evidence_id"], "red_node_id": reading["red_node_id"],
                                "black_node_id": reading["black_node_id"], "measured_v": measured,
                                "predicted_v": predicted, "comparison_band_v": band, "within_band": matched})
            (support if matched else contradictions).append(reading["evidence_id"])

        per_pair_predictions: dict[tuple[str, str], dict[str, float]] = {}
        for pair, variant_results in results_by_pair.items():
            result = variant_results.get(variant_id)
            if result is None:
                continue
            try:
                per_pair_predictions[pair] = {node: _node_voltage(node, variant_graph, result) for node in nodes}
            except KeyError:
                continue
        predictions_by_variant_pair[variant_id] = per_pair_predictions

        if contradictions:
            status = "inconsistent"
        else:
            status = "candidate"
        normalized_errors = [abs(item["measured_v"] - item["predicted_v"]) / item["comparison_band_v"]
                            for item in comparisons]
        score = round(100.0 / (1.0 + sum(normalized_errors) / len(normalized_errors)), 2) if normalized_errors else 0.0
        first_pair = next((pair for pair in pair_order if pair in per_pair_predictions), None)
        predictions = per_pair_predictions.get(first_pair, {}) if first_pair else {}
        hypothesis_records.append({
            "id": variant_id, "title": title, "status": status, "score": score,
            "resolution": ("inconsistent_with_available_readings" if contradictions else
                           "consistent_with_available_readings" if comparisons else "unresolved"),
            "predictions": predictions, "prediction_provenance": "ngspice_actual" if predictions else None,
            "prediction_probe_pair": ({"red_node_id": first_pair[0], "black_node_id": first_pair[1]} if first_pair else None),
            "supporting_evidence_ids": support, "contradicting_evidence_ids": contradictions,
            "comparisons": comparisons, "assumptions": list(assumptions),
        })

    hypothesis_records.append({
        "id": "unknown-or-combined", "title": "Unmodeled, combined, wiring, or measurement fault",
        "status": "candidate", "resolution": "unresolved", "score": 0.0,
        "predictions": {}, "prediction_provenance": None,
        "supporting_evidence_ids": [], "contradicting_evidence_ids": [], "comparisons": [],
        "assumptions": ["No numeric model is claimed for this case."],
    })

    current_candidates = [item for item in hypothesis_records
                          if item["status"] == "candidate" and item["id"] != "unknown-or-combined"
                          and item["comparisons"]]
    next_test: dict[str, Any] | None = None
    candidate_tests: list[tuple[str, str]] = []
    for node in nodes:
        if node == reference:
            continue
        pair = (node, reference)
        if frozenset(pair) in measured_pairs_unordered:
            continue
        if all(pair in predictions_by_variant_pair.get(item["id"], {}) for item in current_candidates):
            candidate_tests.append(pair)
    best: tuple[int, str, str, list[tuple[str, float]]] | None = None
    for red, black in candidate_tests:
        values = [(item["id"], predictions_by_variant_pair[item["id"]][(red, black)][red]
                  - predictions_by_variant_pair[item["id"]][(red, black)][black]) for item in current_candidates]
        separated = 0
        for index, (_, left) in enumerate(values):
            for _, right in values[index + 1:]:
                if abs(left - right) > 2 * _comparison_band(left, right):
                    separated += 1
        if separated == 0:
            continue
        candidate = (separated, red, black, values)
        if best is None or (-candidate[0], candidate[1], candidate[2]) < (-best[0], best[1], best[2]):
            best = candidate
    if best is not None:
        separated, red, black, values = best
        rendered = ", ".join(f"{variant_id}: {value:.4g} V" for variant_id, value in values)
        next_test = {
            "red_node_id": red, "black_node_id": black, "quantity": "voltage", "meter_mode": "DC_voltage",
            "reason": f"This measurement separates {separated} remaining candidate pair(s) in the actual-ngspice scenarios ({rendered}); it is a selection score, not a probability.",
            "selection_score": float(separated),
            "prediction_provenance": "ngspice_actual",
            "predicted_outcomes_v": {variant_id: value for variant_id, value in values},
        }
    elif normalized_readings and current_candidates:
        limitations.append("No unmeasured graph-node-to-ground voltage test was predicted to separate the remaining simulated candidates by more than twice the provisional band.")
    elif not normalized_readings:
        limitations.append("No confirmed readings were supplied; the returned simulated cases are not ranked against measured behavior.")
    if skipped_pairs:
        limitations.append(f"The bounded {MAX_RUNTIME_S:g}-second analysis budget left some probe pairs unsimulated; no prediction was filled in for them.")
    if pair_budget_trimmed:
        limitations.append(f"Only the first {MAX_TEST_PAIRS} unique measurement/test probe pairs were simulated due to the pair-count bound.")
    if not simulation_records:
        limitations.append("No simulator result was produced; hypotheses remain unranked and no numeric prediction is available.")

    return {
        "circuit_id": graph.circuit_id, "circuit_revision": graph.revision,
        "graph_sha256": graph.graph_sha256,
        "provenance": ("ngspice_actual" if any(item["status"] == "succeeded" for item in simulation_records)
                       else "ngspice_failed_no_numeric_predictions"),
        "score_semantics": "heuristic ranking score from normalized residuals; not a probability",
        "comparison_band_formula": "max(0.05 V, 0.10*abs(measured V), 0.10*abs(predicted V)); provisional and not statistically validated",
        "meter_model": {"kind": "ideal_resistive_input", "input_resistance_ohm": METER_INPUT_RESISTANCE_OHM,
                        "connection": "across the reported red and black probe nodes"},
        "hypotheses": hypothesis_records, "next_test": next_test,
        "limitations": list(dict.fromkeys(limitations)), "simulations": simulation_records,
    }
