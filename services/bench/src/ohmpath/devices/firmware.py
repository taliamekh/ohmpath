from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import re
from typing import Literal


MAX_SOURCE_CHARS = 80_000
MAX_TOTAL_CHARS = 200_000
MAX_LINES = 2_000
MAX_LINE_CHARS = 1_000

_BAUD_RE = re.compile(r"\b(?:baud(?:\s*rate)?|serial[_ ]speed|serial_baud)\s*(?:=|:|is)?\s*(\d{3,7})\b", re.IGNORECASE)
_RESET_RE = re.compile(r"\b(?:boot(?:ing)?|reset(?:ting)?|power[- ]on reset)\b", re.IGNORECASE)
_PIN_RE = re.compile(r"\b(?:gpio|pin|led_pin|sda_pin|scl_pin)\s*(?:=|:|number\s+)?\s*(\d{1,3})\b", re.IGNORECASE)
_PIN_FAULT_RE = re.compile(r"\b(?:invalid|unconfigured|not configured|unsupported|undefined)\s+(?:gpio\s+|pin\s*)?(\d{1,3})\b|\bpin\s*(\d{1,3})\s+(?:invalid|unconfigured|not configured|unsupported|undefined)\b", re.IGNORECASE)
_POWER_RE = re.compile(r"\b(?:brown[- ]?out|under[- ]?voltage|undervoltage|low supply|supply voltage low|voltage droop)\b", re.IGNORECASE)
_Category = Literal["baud_mismatch", "boot_loop", "pin_configuration", "power_integrity"]


@dataclass(frozen=True)
class FirmwareObservation:
    evidence_id: str
    source: Literal["serial", "build", "configuration"]
    line_number: int
    captured_at: str
    firmware_revision: str | None
    text: str


@dataclass(frozen=True)
class FirmwareHypothesis:
    hypothesis_id: str
    category: _Category
    status: Literal["candidate"]
    statement: str
    supporting_evidence_ids: tuple[str, ...]
    assumptions: tuple[str, ...]


@dataclass(frozen=True)
class FirmwareCheck:
    check_id: str
    instruction: str
    required_evidence: tuple[str, ...]
    hardware_action: bool = False
    requires_user_authorization: bool = False


@dataclass(frozen=True)
class FirmwareEvidenceReport:
    captured_at: str
    firmware_revision: str | None
    observations: tuple[FirmwareObservation, ...]
    hypotheses: tuple[FirmwareHypothesis, ...]
    checks: tuple[FirmwareCheck, ...]
    raw_input_sha256: str
    parser_version: str = "firmware-evidence-v1"
    provenance: Literal["supplied_text_only"] = "supplied_text_only"


def _timestamp(value: datetime | str) -> str:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("captured_at must be an ISO-8601 timestamp") from exc
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("captured_at must include a timezone")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_firmware_evidence(
    *,
    captured_at: datetime | str,
    firmware_revision: str | None = None,
    serial_text: str = "",
    build_output: str = "",
    configuration_text: str = "",
) -> FirmwareEvidenceReport:
    """Analyze bounded, user-supplied text as evidence; never opens ports or executes code."""
    timestamp = _timestamp(captured_at)
    sources: tuple[tuple[Literal["serial", "build", "configuration"], str], ...] = (
        ("serial", serial_text), ("build", build_output), ("configuration", configuration_text),
    )
    if firmware_revision is not None and (not isinstance(firmware_revision, str) or len(firmware_revision) > 128):
        raise ValueError("firmware_revision must be at most 128 characters")
    if any(not isinstance(text, str) for _, text in sources):
        raise TypeError("firmware inputs must be text")
    if any(len(text) > MAX_SOURCE_CHARS for _, text in sources):
        raise ValueError("each firmware evidence input is limited to 80,000 characters")
    if sum(len(text) for _, text in sources) > MAX_TOTAL_CHARS:
        raise ValueError("firmware evidence is limited to 200,000 characters total")

    observations: list[FirmwareObservation] = []
    source_lines: dict[str, list[FirmwareObservation]] = {name: [] for name, _ in sources}
    canonical_inputs: list[str] = []
    for source, text in sources:
        canonical_inputs.append(f"[{source}]\n{text}")
        for line_number, raw_line in enumerate(text.splitlines()[:MAX_LINES], start=1):
            cleaned = "".join(char for char in raw_line[:MAX_LINE_CHARS] if char in "\t" or ord(char) >= 32).strip()
            if not cleaned:
                continue
            digest = hashlib.sha256(f"{source}\0{line_number}\0{cleaned}".encode("utf-8")).hexdigest()[:20]
            obs = FirmwareObservation(f"fw-{digest}", source, line_number, timestamp, firmware_revision, cleaned)
            observations.append(obs)
            source_lines[source].append(obs)
    if len(observations) > 6_000:
        raise ValueError("firmware evidence contains too many non-empty lines")

    hypotheses: list[FirmwareHypothesis] = []
    checks: list[FirmwareCheck] = []

    def add(category: _Category, statement: str,
            evidence: list[FirmwareObservation], assumptions: tuple[str, ...],
            check: str, *, hardware_action: bool = False) -> None:
        evidence_ids = tuple(dict.fromkeys(item.evidence_id for item in evidence))
        if not evidence_ids:
            return
        seed = category + "\0" + "\0".join(evidence_ids)
        suffix = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
        hypotheses.append(FirmwareHypothesis("fwh-" + suffix, category, "candidate", statement,
                                             evidence_ids, assumptions))
        checks.append(FirmwareCheck("fwc-" + suffix, check, evidence_ids, hardware_action,
                                    requires_user_authorization=hardware_action))

    serial_bauds = [(obs, int(match.group(1))) for obs in source_lines["serial"]
                    for match in [_BAUD_RE.search(obs.text)] if match]
    configured_bauds = [(obs, int(match.group(1))) for obs in source_lines["configuration"]
                        for match in [_BAUD_RE.search(obs.text)] if match]
    build_bauds = [(obs, int(match.group(1))) for obs in source_lines["build"]
                   for match in [_BAUD_RE.search(obs.text)] if match]
    for runtime_obs, runtime_baud in serial_bauds:
        candidates = [(obs, baud) for obs, baud in configured_bauds + build_bauds if baud != runtime_baud]
        if candidates:
            config_obs, config_baud = candidates[0]
            add("baud_mismatch", f"Supplied runtime text names {runtime_baud} baud while supplied configuration/build text names {config_baud} baud.",
                [runtime_obs, config_obs], ("Reported settings may not reflect the active device or host terminal.",),
                f"Compare the terminal capture setting with the deployed firmware's configured baud ({config_baud}) and confirm both belong to the same firmware revision.")
            break

    reset_lines = [obs for obs in source_lines["serial"] if _RESET_RE.search(obs.text)]
    reset_signatures = {re.sub(r"\d+", "#", obs.text.casefold()) for obs in reset_lines}
    if len(reset_lines) >= 3 and (len(reset_signatures) <= 2 or any("loop" in obs.text.casefold() for obs in reset_lines)):
        add("boot_loop", "The supplied serial capture contains repeated boot/reset markers; this is consistent with, but does not prove, a reboot loop.",
            reset_lines[:8], ("The capture window and line ordering are representative of current runtime.",),
            "Collect a longer timestamped serial capture and compare reset intervals with the board's reset-cause output.")

    config_pins = [(obs, int(match.group(1))) for obs in source_lines["configuration"]
                   for match in [_PIN_RE.search(obs.text)] if match]
    fault_pins = [(obs, int(next(group for group in match.groups() if group is not None)))
                  for obs in source_lines["serial"] + source_lines["build"]
                  for match in [_PIN_FAULT_RE.search(obs.text)] if match]
    pin_evidence: list[FirmwareObservation] = []
    pin_statement = "Supplied text reports a pin configuration fault."
    if fault_pins:
        fault_obs, pin_num = fault_pins[0]
        pin_evidence.append(fault_obs)
        pin_evidence.extend(obs for obs, configured in config_pins if configured == pin_num)
        pin_statement = f"Supplied runtime/build text flags pin {pin_num}; this does not establish whether the pin map or physical wiring is wrong."
    elif config_pins:
        pin_evidence.extend(obs for obs, _ in config_pins[:8])
        pin_statement = "Supplied configuration assigns MCU pins; no physical wiring map was provided to verify those assignments."
    if pin_evidence:
        add("pin_configuration", pin_statement, pin_evidence,
            ("The supplied configuration corresponds to the deployed firmware.", "The physical board and wiring have not been independently identified."),
            "Compare each configured pin with the exact board revision's pinout and an unpowered, user-confirmed wiring map.")

    power_evidence = [obs for obs in source_lines["serial"] + source_lines["build"] if _POWER_RE.search(obs.text)]
    if power_evidence:
        add("power_integrity", "Supplied logs mention brownout or low-voltage behavior; this can arise from supply, wiring, load, or reporting issues.",
            power_evidence[:8], ("The log message is a report, not a direct voltage measurement.",),
            "If safe and authorized, measure supply voltage at the board during normal load and verify a common reference.",
            hardware_action=True)

    raw_hash = hashlib.sha256("\n".join(canonical_inputs).encode("utf-8")).hexdigest()
    return FirmwareEvidenceReport(timestamp, firmware_revision, tuple(observations), tuple(hypotheses),
                                  tuple(checks), raw_hash)
