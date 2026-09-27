"""Bounded, revisable circuit drafts from images and user corrections.

This module never treats a visual draft or SPICE prediction as physical evidence.
Only validated resistor/DC-source graphs reach the fixed ngspice compiler.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import threading
from pathlib import Path
from typing import Any
from uuid import UUID

from .models import CircuitComponent, CircuitGraph
from .simulation import run_operating_point


_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
_SOURCES = {"image_visible", "user_reported", "assumed", "unknown"}
_SUPPORTED = {"resistor": ("R", "ohmpath.resistor.v1"),
              "dc_voltage_source": ("V", "ohmpath.dc_source.v1")}


class DraftError(ValueError):
    """Invalid or stale untrusted circuit-draft input."""


def _text(value: Any, name: str, *, maximum: int = 240, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(
            ord(char) < 32 and char not in "\t\n" for char in value):
        raise DraftError(f"invalid {name}")
    return value.strip()


def _source(value: Any, name: str) -> str:
    if not isinstance(value, str) or value not in _SOURCES:
        raise DraftError(f"invalid {name}")
    return value


def _ident(value: Any, name: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise DraftError(f"invalid {name}")
    return value


def _strings(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 16:
        raise DraftError(f"invalid {name}")
    return [_text(item, name) for item in value]


def validate_candidate(value: Any) -> dict[str, Any]:
    """Keep unknown/unsupported parts intact; never compile a partial subset."""
    required = {"intended_function", "components", "ground_node", "assumptions",
                "uncertainties", "unsupported"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {
            "ground_source", "resolved_uncertainties", "resolved_unsupported"}:
        raise DraftError("invalid circuit draft fields")
    parts = value["components"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 32:
        raise DraftError("a circuit draft needs 1 to 32 parts")
    components = []
    refs: set[str] = set()
    for raw in parts:
        fields = {"ref", "kind", "nodes", "value_si", "source", "value_source", "connection_source"}
        if not isinstance(raw, dict) or set(raw) != fields:
            raise DraftError("invalid component fields")
        ref = _ident(raw["ref"], "component reference")
        if ref.casefold() in refs:
            raise DraftError("duplicate component reference")
        refs.add(ref.casefold())
        kind = _text(raw["kind"], "component kind", maximum=40)
        nodes = raw["nodes"]
        if not isinstance(nodes, list) or len(nodes) != 2:
            raise DraftError(f"{ref} needs two terminal slots")
        terminals = [_ident(node, f"{ref} terminal", nullable=True) for node in nodes]
        number = raw["value_si"]
        if number is not None and (isinstance(number, bool) or not isinstance(number, (int, float))
                                   or not math.isfinite(number) or not 0 <= number <= 1e12):
            raise DraftError(f"invalid {ref} value")
        components.append({"ref": ref, "kind": kind, "nodes": terminals,
                           "value_si": float(number) if number is not None else None,
                           "source": _source(raw["source"], f"{ref} source"),
                           "value_source": _source(raw["value_source"], f"{ref} value source"),
                           "connection_source": _source(raw["connection_source"], f"{ref} connection source")})
    return {"intended_function": _text(value["intended_function"], "intended function", nullable=True),
            "components": components, "ground_node": _ident(value["ground_node"], "ground node", nullable=True),
            "ground_source": _source(value.get("ground_source", "unknown"), "ground source"),
            "assumptions": _strings(value["assumptions"], "assumptions"),
            "uncertainties": _strings(value["uncertainties"], "uncertainties"),
            "unsupported": _strings(value["unsupported"], "unsupported")}


def _questions(draft: dict[str, Any]) -> list[dict[str, str]]:
    questions = []
    if draft["ground_node"] is None or draft["ground_source"] in {"unknown", "assumed"}:
        questions.append({"target": "supply return", "issue": "ground/reference node unconfirmed",
                          "request": "Identify the supply negative or ground rail from a clearer view or your wiring plan."})
    for part in draft["components"]:
        ref = part["ref"]
        if part["source"] in {"unknown", "assumed"}:
            questions.append({"target": ref, "issue": "component identity unconfirmed",
                              "request": f"Identify {ref} from a clearer view or your wiring plan before modeling it."})
        if part["kind"] not in _SUPPORTED:
            questions.append({"target": ref, "issue": f"{part['kind']} is outside the DC resistor/source model",
                              "request": f"Describe {ref} and its role; this part cannot be silently omitted from SPICE."})
        if part["value_si"] is None or part["value_source"] == "unknown":
            questions.append({"target": ref, "issue": "value unreadable or unknown",
                              "request": f"Confirm {ref}'s value or provide a closer, perpendicular image of its marking/bands."})
        for index, node in enumerate(part["nodes"], 1):
            if node is None:
                questions.append({"target": f"{ref} terminal {index}", "issue": "connection hidden or unknown",
                                  "request": f"Trace {ref} terminal {index} to a named row or rail in a clearer view."})
        if part["connection_source"] in {"unknown", "assumed"}:
            questions.append({"target": ref, "issue": "terminal connection not confirmed",
                              "request": f"Confirm both {ref} terminal rows or rails; a wire crossing is not a connection."})
        if part["value_source"] == "assumed" and not draft["assumptions"]:
            questions.append({"target": ref, "issue": "assumed value is not disclosed",
                              "request": f"State the assumed value for {ref} explicitly or confirm its marking."})
    for item in draft["unsupported"]:
        questions.append({"target": "circuit", "issue": item,
                          "request": "Clarify this unsupported or unresolved part before simulation."})
    return questions[:24]


def _graph(draft: dict[str, Any], revision: str) -> CircuitGraph:
    questions = _questions(draft)
    if questions or draft["uncertainties"]:
        raise DraftError("Complete the named values, connections, ground, and uncertainties before simulation.")
    components = []
    try:
        for part in draft["components"]:
            prefix, model_id = _SUPPORTED[part["kind"]]
            if not part["ref"].startswith(prefix):
                raise DraftError(f"{part['ref']} needs a {prefix}-prefixed reference")
            components.append(CircuitComponent(ref=part["ref"], kind=part["kind"],
                                               nodes=tuple(part["nodes"]), value_si=part["value_si"],
                                               model_id=model_id))
        return CircuitGraph(circuit_id="Photo" + revision[:12], revision="D" + revision[:16],
                            ground_nodes=(draft["ground_node"],), components=tuple(components))
    except ValueError as error:
        raise DraftError(f"The proposed graph is invalid: {error}") from error


class CircuitReconstruction:
    """One private, compact draft per photo context, without retained pixels."""

    def __init__(self, data_dir: Path | None = None):
        self.lock = threading.RLock()
        self.path = Path(data_dir) / "photo-circuit-drafts.json" if data_dir else None
        self.records: dict[str, dict[str, Any]] = {}
        if self.path and self.path.is_file() and self.path.stat().st_size <= 1_000_000:
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and len(loaded) <= 32:
                    for key, record in loaded.items():
                        try:
                            UUID(key)
                            draft = record["draft"]
                            if not re.fullmatch(r"[a-f0-9]{64}", draft["image_revision"]):
                                continue
                            candidate = {field: draft[field] for field in (
                                "intended_function", "components", "ground_node", "ground_source",
                                "assumptions", "uncertainties", "unsupported")}
                            checked = validate_candidate(candidate)
                            self.records[key] = {"draft": {"context_id": key,
                                "image_revision": draft["image_revision"],
                                "draft_revision": hashlib.sha256(json.dumps(checked, sort_keys=True).encode()).hexdigest(),
                                "graph_sha256": None, **checked,
                                "questions": [{"target": "whole circuit", "issue": "restored draft needs review",
                                               "request": "Confirm the retained circuit before another simulation."}],
                                "simulation_ready": False, "retained_refs": [part["ref"] for part in checked["components"]]},
                                "simulation": None}
                        except (KeyError, TypeError, ValueError, AttributeError):
                            continue
            except (OSError, ValueError, TypeError):
                self.records = {}

    def _save(self) -> None:
        if self.path is None:
            return
        while len(self.records) > 32:
            self.records.pop(next(iter(self.records)))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.records, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, self.path)

    def snapshot(self, context_id: str) -> dict[str, Any] | None:
        with self.lock:
            return copy.deepcopy(self.records.get(context_id))

    def clear(self, context_id: str) -> None:
        with self.lock:
            self.records.pop(context_id, None)
            self._save()

    def carry_forward(self, context_id: str, image_revision: str) -> dict[str, Any] | None:
        """Keep old part hypotheses for a new photo, but revoke simulation readiness."""
        with self.lock:
            record = self.records.get(context_id)
            if record is None or record["draft"]["image_revision"] == image_revision:
                return copy.deepcopy(record)
            draft = record["draft"]
            old_revision = draft["image_revision"]
            draft["image_revision"] = image_revision
            draft["draft_revision"] = hashlib.sha256(
                f"{draft['draft_revision']}:{image_revision}".encode()).hexdigest()
            draft["graph_sha256"] = None
            draft["simulation_ready"] = False
            draft["prior_image_revision"] = old_revision
            draft["questions"] = [{"target": "whole circuit", "issue": "prior image facts need review",
                                   "request": "Compare this new view with the retained part list and confirm changed values or connections."},
                                  *draft["questions"]][:24]
            record["simulation"] = None
            self._save()
            return copy.deepcopy(record)

    def remember(self, context_id: str, image_revision: str, candidate: Any,
                 *, cancel_event: threading.Event | None = None) -> dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise DraftError("draft cancelled")
        try:
            UUID(context_id)
        except (ValueError, TypeError, AttributeError) as error:
            raise DraftError("invalid draft context") from error
        if not re.fullmatch(r"[a-f0-9]{64}", image_revision):
            raise DraftError("invalid draft context or image revision")
        draft = validate_candidate(candidate)
        resolved_uncertainties = set(_strings(candidate.get("resolved_uncertainties", []), "resolved uncertainties"))
        resolved_unsupported = set(_strings(candidate.get("resolved_unsupported", []), "resolved unsupported"))
        with self.lock:
            prior = copy.deepcopy(self.records.get(context_id))
        retained_refs: list[str] = []
        if prior is not None:
            old = prior["draft"]
            incoming = {part["ref"].casefold(): part for part in draft["components"]}
            retained = [part for part in old["components"] if part["ref"].casefold() not in incoming]
            retained_refs = [part["ref"] for part in retained]
            draft["components"] = [*retained, *draft["components"]]
            if len(draft["components"]) > 32:
                raise DraftError("too many retained components; clear the circuit draft to start a different circuit")
            if draft["intended_function"] is None:
                draft["intended_function"] = old["intended_function"]
            if draft["ground_node"] is None:
                draft["ground_node"] = old["ground_node"]
                draft["ground_source"] = old["ground_source"]
            for field, resolved in (("uncertainties", resolved_uncertainties),
                                    ("unsupported", resolved_unsupported)):
                draft[field] = list(dict.fromkeys([*draft[field],
                    *(item for item in old[field] if item not in resolved)]))[:16]
            draft["assumptions"] = list(dict.fromkeys([*old["assumptions"], *draft["assumptions"]]))[:16]
        canonical = json.dumps({"image_revision": image_revision, "draft": draft},
                               sort_keys=True, separators=(",", ":"))
        revision = hashlib.sha256(canonical.encode()).hexdigest()
        questions = _questions(draft)
        graph_sha = None
        ready = False
        if not questions and not draft["uncertainties"]:
            try:
                graph_sha = _graph(draft, revision).graph_sha256
                ready = True
            except DraftError as error:
                questions.append({"target": "circuit", "issue": "invalid proposed topology",
                                  "request": str(error)[:240]})
        result = {"draft": {"context_id": context_id, "image_revision": image_revision,
                            "draft_revision": revision, "graph_sha256": graph_sha,
                            **draft, "retained_refs": retained_refs,
                            "questions": questions, "simulation_ready": ready},
                  "simulation": None}
        with self.lock:
            if cancel_event is not None and cancel_event.is_set():
                raise DraftError("draft cancelled")
            self.records[context_id] = result
            self._save()
        return copy.deepcopy(result)

    def simulate(self, context_id: str, image_revision: str, draft_revision: str,
                 *, cancel_event: threading.Event | None = None) -> dict[str, Any]:
        with self.lock:
            stored = copy.deepcopy(self.records.get(context_id))
        if not stored or stored["draft"]["image_revision"] != image_revision or stored["draft"]["draft_revision"] != draft_revision:
            raise DraftError("stale circuit draft")
        draft = stored["draft"]
        if not draft["simulation_ready"]:
            return {"status": "blocked", "draft_revision": draft_revision,
                    "graph_sha256": None, "provenance": "none", "node_voltages_v": {},
                    "reason": draft["questions"][0]["request"] if draft["questions"] else "Resolve circuit uncertainty first.",
                    "conditional": True}
        if cancel_event is not None and cancel_event.is_set():
            return {"status": "cancelled", "draft_revision": draft_revision,
                    "graph_sha256": draft["graph_sha256"], "provenance": "none",
                    "node_voltages_v": {}, "reason": "Simulation cancelled.", "conditional": True}
        graph = _graph(draft, draft_revision)
        result = run_operating_point(graph, cancel_event=cancel_event)
        summary = {"status": result.status, "draft_revision": draft_revision,
                   "graph_sha256": result.graph_sha256, "provenance": result.provenance,
                   "node_voltages_v": result.node_voltages_v if result.status == "succeeded" else {},
                   "reason": result.error, "conditional": True,
                   "simulation_id": result.simulation_id, "simulator_sha256": result.simulator_sha256}
        with self.lock:
            current = self.records.get(context_id)
            if not current or current["draft"]["draft_revision"] != draft_revision or current["draft"]["image_revision"] != image_revision:
                raise DraftError("stale simulation result")
            if cancel_event is not None and cancel_event.is_set():
                raise DraftError("simulation cancelled")
            current["simulation"] = summary
            self._save()
        return copy.deepcopy(summary)
