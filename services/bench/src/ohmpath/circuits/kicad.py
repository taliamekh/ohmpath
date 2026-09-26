from __future__ import annotations

import hashlib
import math
import os
import re
import shutil
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
_ALLOWED_TAGS = {"export", "version", "design", "components", "comp", "value", "footprint",
                 "datasheet", "libsource", "lib", "part", "libparts", "fields", "field",
                 "libraries", "library", "uri", "nets", "net", "node"}
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
    root = source_root.resolve(strict=True)
    source = schematic_path.resolve(strict=True)
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise ValueError("KiCad schematic path is outside the approved source root") from exc
    if source.suffix.casefold() != ".kicad_sch" or not source.is_file():
        raise ValueError("expected an approved .kicad_sch file")
    kicad_cli_path = kicad_cli_path or os.environ.get("OHMPATH_KICAD_CLI")
    if kicad_cli_path is not None:
        executable = Path(kicad_cli_path).expanduser().resolve()
    else:
        found = shutil.which("kicad-cli.exe") or shutil.which("kicad-cli")
        executable = Path(found).resolve() if found else _DEFAULT_KICAD_CLI
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


def import_kicad_xml(xml: str | bytes | Path, *, source_root: Path | None = None) -> CircuitGraph:
    """Normalize the safe, passive subset of a KiCad XML netlist.

    The adapter parses exported XML only. It never invokes KiCad or executes embedded
    simulator/model text; component kinds and pin numbers must match the fixed registry.
    """
    if isinstance(xml, Path):
        path = xml.resolve(strict=True)
        if source_root is not None:
            root = source_root.resolve(strict=True)
            try:
                path.relative_to(root)
            except ValueError as exc:
                raise ValueError("KiCad XML path is outside the approved source root") from exc
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
    components_element = root_element.find("components")
    nets_element = root_element.find("nets")
    if root_element.tag != "export" or components_element is None or nets_element is None:
        raise ValueError("expected KiCad XML export with components and nets")

    component_values: dict[str, tuple[str, float]] = {}
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
        component_values[ref] = (kind, _parse_value(value_text, ref))

    terminal_map: dict[str, dict[str, str]] = {ref: {} for ref in component_values}
    raw_nodes: dict[str, str] = {}
    for net in nets_element.findall("net"):
        code = net.attrib.get("code", "")
        raw_name = net.attrib.get("name", "")
        if not re.fullmatch(r"\d+", code):
            raise ValueError("net code is missing or invalid")
        node_id = _node_name(raw_name, code)
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
    digest = hashlib.sha256(raw).hexdigest()[:12]
    return CircuitGraph(circuit_id="kicad_import", revision=f"xml_{digest}",
                        ground_nodes=grounds, components=tuple(components))
