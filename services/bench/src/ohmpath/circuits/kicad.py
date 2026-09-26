from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from xml.etree.ElementTree import ParseError

from defusedxml import ElementTree

from .models import CircuitComponent, CircuitGraph


_VALUE = re.compile(r"^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([fpnumkKMG]?)\s*$")
_SCALE = {"": 1.0, "f": 1e-15, "p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3,
          "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9}
_ALLOWED_TAGS = {"export", "version", "design", "source", "date", "tool", "sheet",
                 "title_block", "title", "company", "rev", "comment", "components", "comp",
                 "value", "footprint", "datasheet", "libsource", "libparts", "libpart",
                 "fields", "field", "property", "sheetpath", "tstamps", "units", "unit",
                 "pins", "pin", "libraries", "library", "uri", "nets", "net", "node"}
_ALLOWED_CHILDREN = {
    "export": {"version", "design", "components", "libparts", "libraries", "nets"},
    "design": {"source", "date", "tool", "sheet"},
    "sheet": {"title_block"},
    "title_block": {"title", "company", "rev", "date", "source", "comment"},
    "components": {"comp"},
    "comp": {"value", "footprint", "datasheet", "fields", "libsource", "property", "sheetpath",
             "tstamps", "units"},
    "units": {"unit"},
    "unit": {"pins"},
    "libparts": {"libpart"},
    "libpart": {"fields", "pins"},
    "fields": {"field"},
    "pins": {"pin"},
    "libraries": {"library"},
    "library": {"uri"},
    "nets": {"net"},
    "net": {"node"},
}
_DIRECTIVE = re.compile(r"(?i)(?:^|[\s;])\.(?:control|endc|include|lib|shell|exec|save|print|plot|tran|ac|op|measure)\b")
_SHEET_REFERENCE = re.compile(rb"\(\s*sheet\b", re.IGNORECASE)
_SCHEMATIC_DIRECTIVE = re.compile(rb"\.(?:control|endc|include|lib|shell|exec)\b", re.IGNORECASE)
_LIB_IDS = re.compile(rb'\(\s*lib_id\s+"([^"]+)"\s*\)')
_CURATED_PARTS = {"resistor": ("Device", "R"),
                  "dc_voltage_source": ("Simulation_SPICE", "VDC")}
_DEFAULT_KICAD_CLI = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs/KiCad/10.0/bin/kicad-cli.exe"


def _parse_value(text: str, ref: str) -> float:
    match = _VALUE.fullmatch(text)
    if not match:
        raise ValueError(f"unsupported or unsafe value for {ref}")
    result = float(match.group(1)) * _SCALE[match.group(2)]
    if not math.isfinite(result) or result < 0 or result > 1e12:
        raise ValueError(f"value outside supported range for {ref}")
    return result


def _node_name(raw_name: str, code: str) -> str:
    if raw_name in {"GND", "0", "/GND"}:
        return "GND"
    # Net labels are data. Normalize punctuation without ever interpreting path-like content.
    stem = re.sub(r"[^A-Za-z0-9_]", "_", raw_name).strip("_")
    if not stem or not stem[0].isalpha():
        stem = "N_" + stem
    if len(stem) > 20:
        stem = stem[:20]
    suffix = hashlib.sha256((raw_name + "\0" + code).encode("utf-8")).hexdigest()[:8]
    return f"{stem}_{suffix}"


def _approved_source(path: Path, source_root: Path, suffix: str) -> Path:
    root = source_root.resolve(strict=True)
    source = path.resolve(strict=True)
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise ValueError("KiCad source path is outside the approved source root") from exc
    if source.suffix.casefold() != suffix or not source.is_file():
        raise ValueError(f"expected an approved {suffix} file")
    if source.as_posix().startswith("//"):
        raise ValueError("network KiCad sources are unsupported")
    original_root = source_root.absolute()
    original = path.absolute()
    try:
        original_relative = original.relative_to(original_root)
    except ValueError as exc:
        raise ValueError("KiCad source path is outside the approved source root") from exc
    current = original_root
    for part in original_relative.parts:
        current = current / part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise ValueError("KiCad source links are unsupported")
    return source


def export_kicad_xml(
    schematic_path: Path,
    *,
    source_root: Path,
    kicad_cli_path: str | Path | None = None,
    timeout_s: float = 15.0,
) -> bytes:
    """Run KiCad's fixed XML-netlist export against one approved schematic path."""
    if not 0 < timeout_s <= 30:
        raise ValueError("timeout_s must be greater than 0 and no more than 30")
    source = _approved_source(schematic_path, source_root, ".kicad_sch")
    if source.stat().st_size > 5_000_000:
        raise ValueError("KiCad schematic exceeds the 5 MB import limit")
    source_bytes = source.read_bytes()
    if _SHEET_REFERENCE.search(source_bytes):
        raise ValueError("hierarchical KiCad sheet references require separate review")
    if _SCHEMATIC_DIRECTIVE.search(source_bytes):
        raise ValueError("KiCad schematic contains unsupported simulator directives")
    lib_ids = set(_LIB_IDS.findall(source_bytes))
    if not lib_ids or not lib_ids <= {b"Device:R", b"Simulation_SPICE:VDC"}:
        raise ValueError("KiCad schematic contains an uncurated component library")
    executable = _DEFAULT_KICAD_CLI.resolve()
    if kicad_cli_path is not None and Path(kicad_cli_path).expanduser().resolve() != executable:
        raise ValueError("only the pinned KiCad CLI executable is supported")
    if not executable.is_file():
        raise FileNotFoundError("KiCad CLI executable was not found")

    with tempfile.TemporaryDirectory(prefix="ohmpath-kicad-") as directory:
        work = Path(directory)
        output = work / "export.xml"
        stdout_path, stderr_path = work / "stdout.log", work / "stderr.log"
        start = time.monotonic()
        with stdout_path.open("wb") as stdout_file, stderr_path.open("wb") as stderr_file:
            process = subprocess.Popen(
                [str(executable), "sch", "export", "netlist", "--format", "kicadxml",
                 "--output", str(output), str(source)],
                cwd=work, stdout=stdout_file, stderr=stderr_file, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while process.poll() is None:
                output_bytes = stdout_path.stat().st_size + stderr_path.stat().st_size
                if output_bytes > 100_000:
                    process.kill()
                    process.wait()
                    raise ValueError("KiCad CLI output exceeded the 100 KB limit")
                if time.monotonic() - start > timeout_s:
                    process.kill()
                    process.wait()
                    raise TimeoutError("KiCad XML export exceeded its time limit")
                time.sleep(0.02)
        if stdout_path.stat().st_size + stderr_path.stat().st_size > 100_000:
            raise ValueError("KiCad CLI output exceeded the 100 KB limit")
        if process.returncode != 0:
            detail = (stderr_path.read_bytes() + stdout_path.read_bytes())[:100_000].decode("utf-8", errors="replace")
            raise RuntimeError(f"KiCad XML export failed with status {process.returncode}: {detail[-2000:]}")
        if not output.is_file() or output.stat().st_size > 5_000_000:
            raise ValueError("KiCad XML export is missing or exceeds the 5 MB import limit")
        return output.read_bytes()


def import_kicad_xml(xml: str | bytes | Path, *, source_root: Path | None = None,
                     require_library_identity: bool = False) -> CircuitGraph:
    """Normalize the safe, passive subset of a KiCad XML netlist.

    The adapter parses exported XML only. It never invokes KiCad or executes embedded
    simulator/model text; component kinds and pin numbers must match the fixed registry.
    """
    if isinstance(xml, Path):
        if source_root is None:
            raise ValueError("approved source root required for KiCad XML path")
        path = _approved_source(xml, source_root, ".xml")
        raw = path.read_bytes()
    else:
        raw = xml.encode("utf-8") if isinstance(xml, str) else xml
    if len(raw) > 5_000_000:
        raise ValueError("KiCad XML exceeds the 5 MB import limit")
    try:
        root_element = ElementTree.fromstring(raw)
    except (ParseError, ValueError) as exc:
        raise ValueError("invalid KiCad XML") from exc
    tags = {element.tag for element in root_element.iter()}
    if not tags.issubset(_ALLOWED_TAGS):
        raise ValueError("KiCad XML contains unsupported or executable content")
    if sum(1 for _ in root_element.iter()) > 10_000:
        raise ValueError("KiCad XML contains too many elements")
    for element in root_element.iter():
        if any(child.tag not in _ALLOWED_CHILDREN.get(element.tag, set()) for child in element):
            raise ValueError("KiCad XML contains unsupported structure")
        if (_DIRECTIVE.search(element.text or "") or _DIRECTIVE.search(element.tail or "")
                or any(_DIRECTIVE.search(value) for value in element.attrib.values())):
            raise ValueError("KiCad XML contains simulator directives")
    components_element = root_element.find("components")
    nets_element = root_element.find("nets")
    if root_element.tag != "export" or components_element is None or nets_element is None:
        raise ValueError("expected KiCad XML export with components and nets")
    if require_library_identity and (root_element.get("version") != "E"
                                     or not (root_element.findtext("design/tool") or "").startswith("Eeschema 10.")):
        raise ValueError("unsupported KiCad XML export version")

    component_values: dict[str, tuple[str, float]] = {}
    part_rows = root_element.findall("libparts/libpart")
    defined_parts = {(part.get("lib"), part.get("part")): part for part in part_rows}
    if len(defined_parts) != len(part_rows):
        raise ValueError("duplicate KiCad library parts")
    for comp in components_element.findall("comp"):
        ref = comp.attrib.get("ref", "")
        value_text = comp.findtext("value", default="")
        if ref.startswith("R"):
            kind, model = "resistor", "ohmpath.resistor.v1"
        elif ref.startswith("V"):
            kind, model = "dc_voltage_source", "ohmpath.dc_source.v1"
        else:
            raise ValueError(f"no curated simulation model for component {ref!r}")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,31}", ref) or ref in component_values:
            raise ValueError("component references must be unique simple identifiers")
        source = comp.find("libsource")
        if source is None:
            if require_library_identity or defined_parts:
                raise ValueError(f"component {ref} lacks a curated library identity")
        else:
            part_key = (source.get("lib"), source.get("part"))
            if part_key != _CURATED_PARTS[kind] or part_key not in defined_parts:
                raise ValueError(f"no curated simulation model for component {ref!r}")
            pins = defined_parts[part_key].findall("pins/pin")
            if len(pins) != 2 or {pin.get("num") for pin in pins} != {"1", "2"}:
                raise ValueError(f"unsupported library pin mapping for {ref}")
            if kind == "dc_voltage_source":
                metadata = {field.get("name"): field.text or "" for field in comp.findall("fields/field")}
                params = metadata.get("Sim.Params")
                if params is not None:
                    match = re.fullmatch(r"dc\(\s*([^()]+)\s*\)", params, re.IGNORECASE)
                    if match is None or not math.isclose(_parse_value(match.group(1), ref),
                                                        _parse_value(value_text, ref), rel_tol=1e-9):
                        raise ValueError(f"source simulation metadata disagrees with {ref}")
                if metadata.get("Sim.Device", "SPICE") != "SPICE" or metadata.get("Sim.Pins", "1=1 2=2") != "1=1 2=2":
                    raise ValueError(f"unsupported simulation pin mapping for {ref}")
        component_values[ref] = (kind, _parse_value(value_text, ref))

    terminal_map: dict[str, dict[str, str]] = {ref: {} for ref in component_values}
    raw_nodes: dict[str, str] = {}
    seen_codes: set[str] = set()
    seen_names: set[str] = set()
    for net in nets_element.findall("net"):
        code = net.attrib.get("code", "")
        raw_name = net.attrib.get("name", "")
        if not re.fullmatch(r"\d+", code):
            raise ValueError("net code is missing or invalid")
        if code in seen_codes or raw_name in seen_names:
            raise ValueError("duplicate KiCad net identity")
        seen_codes.add(code)
        seen_names.add(raw_name)
        node_id = _node_name(raw_name, code)
        if node_id in raw_nodes and raw_nodes[node_id] != raw_name:
            raise ValueError("KiCad net labels collide after normalization")
        raw_nodes[node_id] = raw_name
        for node in net.findall("node"):
            ref, pin = node.attrib.get("ref", ""), node.attrib.get("pin", "")
            if ref not in terminal_map or pin not in {"1", "2"}:
                raise ValueError("missing component or unsupported pin mapping in KiCad XML")
            if pin in terminal_map[ref]:
                raise ValueError(f"duplicate pin mapping for {ref}.{pin}")
            terminal_map[ref][pin] = node_id

    components = []
    for ref, (kind, value) in component_values.items():
        pins = terminal_map[ref]
        if set(pins) != {"1", "2"}:
            raise ValueError(f"component {ref} is missing required pin mappings 1 and 2")
        model = "ohmpath.resistor.v1" if kind == "resistor" else "ohmpath.dc_source.v1"
        components.append(CircuitComponent(ref=ref, kind=kind, nodes=(pins["1"], pins["2"]),
                                           value_si=value, model_id=model))
    grounds = tuple(node for node, raw_name in raw_nodes.items() if raw_name in {"GND", "0", "/GND"})
    if not grounds:
        raise ValueError("KiCad import requires an explicitly named GND or 0 net")
    # KiCad writes a fresh export date and an absolute source path. Neither is
    # an electrical change, so derive the revision from the validated graph.
    canonical = json.dumps({"ground_nodes": sorted(grounds), "components": sorted(
        (component.model_dump(mode="json") for component in components), key=lambda item: item["ref"]),
    }, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    return CircuitGraph(circuit_id="kicad_import", revision=f"xml_{digest}",
                        ground_nodes=grounds, components=tuple(components))


def import_kicad_schematic(schematic_path: Path, *, source_root: Path,
                            kicad_cli_path: str | Path | None = None,
                            timeout_s: float = 15.0) -> CircuitGraph:
    """Export and import one explicitly reviewed local schematic via fixed KiCad CLI."""
    xml = export_kicad_xml(schematic_path, source_root=source_root,
                           kicad_cli_path=kicad_cli_path, timeout_s=timeout_s)
    return import_kicad_xml(xml, require_library_identity=True)
