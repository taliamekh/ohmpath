"""Conservative HT118A OCR-text parser; it emits candidates, never evidence."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from uuid import uuid4

from ohmpath.contracts import MeasurementCandidate

_NUMBER_AND_UNIT = re.compile(
    r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mV|V|mA|A|MΩ|kΩ|Ω|Mohm|kohm|ohm)\s*$",
)
_UNIT_SCALE = {
    "v": (Decimal("1"), "V", "voltage"),
    "mv": (Decimal("0.001"), "V", "voltage"),
    "a": (Decimal("1"), "A", "current"),
    "ma": (Decimal("0.001"), "A", "current"),
    "ohm": (Decimal("1"), "ohm", "resistance"),
    "ω": (Decimal("1"), "ohm", "resistance"),
    "kohm": (Decimal("1000"), "ohm", "resistance"),
    "kω": (Decimal("1000"), "ohm", "resistance"),
    "Mohm": (Decimal("1000000"), "ohm", "resistance"),
    "MΩ": (Decimal("1000000"), "ohm", "resistance"),
}
_MODE_QUANTITY = {
    "dc_voltage": "voltage", "ac_voltage": "voltage", "voltage": "voltage",
    "resistance": "resistance", "continuity": "resistance",
    "dc_current": "current", "ac_current": "current", "current": "current",
}


def parse_meter_candidate(
    text: str,
    *,
    request_id: str,
    meter_mode: str | None,
    expected_mode: str | None = None,
    unstable: bool = False,
    candidate_id: str | None = None,
) -> MeasurementCandidate:
    """Parse OCR text into the shared candidate shape.

    ``meter_mode`` must be recognized from the display or supplied by a verified
    request context. A mode mismatch, missing unit, blank, ambiguous OCR, or OL
    cannot become a numeric value. This function has no confirmation operation.
    """
    if not request_id:
        raise ValueError("request_id is required")
    if len(text) > 4096:
        raise ValueError("meter text exceeds 4096 characters")
    original = text
    normalized = text.replace("−", "-").replace("–", "-").strip()
    mode = meter_mode.strip().casefold() if meter_mode else None
    expected = expected_mode.strip().casefold() if expected_mode else None
    ambiguities: list[str] = []

    state = "unknown"
    value: str | None = None
    si_unit: str | None = None
    original_unit: str | None = None
    original_number: str | None = None

    if not normalized:
        ambiguities.append("blank_display")
    elif unstable:
        ambiguities.append("unstable_display")
        state = "unstable"
    elif mode is None or mode not in _MODE_QUANTITY:
        ambiguities.append("meter_mode_unknown")
    elif expected is not None and (expected not in _MODE_QUANTITY or expected != mode):
        ambiguities.append("meter_mode_changed")
    elif re.fullmatch(r"(?:OL|O\.L\.|OVER(?:LOAD)?)", normalized, re.IGNORECASE):
        state = "over_limit"
    else:
        match = _NUMBER_AND_UNIT.fullmatch(normalized)
        if match is None:
            ambiguities.append("sign_decimal_or_unit_ambiguous")
        else:
            number_text, original_unit = match.groups()
            unit_key = original_unit if original_unit.startswith("M") else original_unit.casefold()
            multiplier, canonical_unit, quantity = _UNIT_SCALE[unit_key]
            expected_quantity = _MODE_QUANTITY[mode]
            if quantity != expected_quantity:
                ambiguities.append("unit_conflicts_with_meter_mode")
            elif expected is not None and _MODE_QUANTITY[expected] != quantity:
                ambiguities.append("requested_mode_conflicts_with_unit")
            else:
                try:
                    numeric = Decimal(number_text) * multiplier
                except InvalidOperation:
                    ambiguities.append("invalid_decimal")
                else:
                    if not numeric.is_finite():
                        ambiguities.append("invalid_decimal")
                    else:
                        state = "numeric"
                        value = format(numeric.normalize(), "f")
                        si_unit = canonical_unit
                        original_number = number_text

    return MeasurementCandidate(
        candidate_id=candidate_id or str(uuid4()),
        request_id=request_id,
        original_text=original,
        value=value,
        si_unit=si_unit,
        original_unit=original_unit,
        original_number=original_number,
        display_state=state,
        source="ocr",
        ambiguities=ambiguities,
    )
