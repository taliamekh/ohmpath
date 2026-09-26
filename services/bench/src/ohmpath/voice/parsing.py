from __future__ import annotations

import re
from decimal import Decimal

from ohmpath.contracts import MeasurementCandidate
from ohmpath.session.store import opaque_id

WORDS = dict(zip("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(), range(20)))
WORDS.update(dict(zip("twenty thirty forty fifty sixty seventy eighty ninety".split(), range(20, 100, 10))))
UNITS = {
    "v": ("V", "1"), "volt": ("V", "1"), "volts": ("V", "1"),
    "mv": ("V", ".001"), "millivolt": ("V", ".001"), "millivolts": ("V", ".001"),
    "uv": ("V", ".000001"), "microvolt": ("V", ".000001"), "microvolts": ("V", ".000001"),
    "ohm": ("ohm", "1"), "ohms": ("ohm", "1"), "kohm": ("ohm", "1000"),
    "kiloohm": ("ohm", "1000"), "kiloohms": ("ohm", "1000"),
    "megohm": ("ohm", "1000000"), "megohms": ("ohm", "1000000"),
    "a": ("A", "1"), "amp": ("A", "1"), "amps": ("A", "1"), "amperes": ("A", "1"),
    "ma": ("A", ".001"), "milliamps": ("A", ".001"), "milliamperes": ("A", ".001"),
    "ua": ("A", ".000001"), "microamps": ("A", ".000001"), "microamperes": ("A", ".000001"),
}


def spoken_number(text: str) -> str:
    text = text.strip().replace("negative ", "minus ").replace("positive ", "plus ")
    sign = ""
    if text.startswith(("minus ", "plus ")):
        sign = "-" if text.startswith("minus ") else "+"
        text = text.split(" ", 1)[1]
    if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", text):
        if sign and text[0] in "+-":
            raise ValueError("multiple signs")
        return sign + text
    parts = text.split(" point ") if " point " in text else ("", text[6:]) if text.startswith("point ") else [text]
    if len(parts) > 2:
        raise ValueError("more than one decimal point")
    integer_words = parts[0].replace("-", " ").split()
    if not integer_words and len(parts) == 1:
        raise ValueError("no number")
    total, group = 0, 0
    last_kind = None
    for word in integer_words:
        if word == "and" and group >= 100:
            continue
        if word in WORDS:
            number = WORDS[word]
            if last_kind == "small" and group < 100:
                raise ValueError("ambiguous adjacent number words; use an explicit decimal")
            if last_kind == "tens" and number >= 10:
                raise ValueError("ambiguous number words")
            group += number
            last_kind = "tens" if number >= 20 else "small"
        elif word == "hundred" and 0 < group < 10:
            group *= 100
            last_kind = "scale"
        elif word == "thousand" and 0 < group < 1000:
            total += group * 1000
            group = 0
            last_kind = "scale"
        elif word.isdigit() and len(integer_words) == 1:
            group = int(word)
        else:
            raise ValueError("unrecognized number wording")
    integer = str(total + group)
    if len(parts) == 2:
        digits = []
        for word in parts[1].split():
            if word in WORDS and WORDS[word] < 10:
                digits.append(str(WORDS[word]))
            elif word.isdigit():
                digits.append(word)
            else:
                raise ValueError("read decimal digits individually")
        if not digits:
            raise ValueError("missing decimal digits")
        integer += "." + "".join(digits)
    return sign + integer


def route_utterance(text: str) -> str:
    normalized = text.lower().strip().rstrip(".!?")
    if normalized in {"stop", "cancel", "pause", "stop speaking", "mute"}:
        return "stop"
    if normalized in {"yes", "correct", "confirm", "that is correct", "yes that's correct"}:
        return "confirmation"
    if normalized.startswith(("why ", "what ", "how ", "where ", "can ", "help ", "is ", "does ", "should ")):
        return "question"
    if "?" in text:
        return "question"
    return "reading"


def parse_reading(text: str, request_id: str, *, meter_mode: str | None = None) -> MeasurementCandidate:
    normalized = text.lower().strip().rstrip(".! ")
    ambiguities = []
    display, value, unit, original_unit, original_number = "unknown", None, None, None, None
    if not text.strip():
        ambiguities.append("No speech was detected.")
    elif route_utterance(text) != "reading":
        ambiguities.append("This utterance is not a measurement reading.")
    elif any(word in normalized.split() for word in ("maybe", "or", "unstable", "uncertain", "approximately")):
        ambiguities.append("The spoken reading is uncertain; please read it again.")
    else:
        for prefix in ("it says ", "the reading is ", "i read ", "actually ", "correction "):
            if normalized.startswith(prefix):
                normalized = normalized[len(prefix):]
        if normalized in {"ol", "o l", "over limit", "overlimit", "overload"}:
            display = "over_limit"
        else:
            normalized = re.sub(r"\bkilo\s+ohms?\b", "kiloohms", normalized)
            normalized = re.sub(r"\bmeg(?:a)?\s+ohms?\b", "megohms", normalized)
            tokens = normalized.split()
            explicit_mode = None
            if tokens and tokens[-1] in {"dc", "ac"}:
                explicit_mode = tokens.pop()
            if explicit_mode and meter_mode and meter_mode != f"{explicit_mode.upper()}_voltage":
                ambiguities.append("The spoken AC/DC mode differs from the active meter test.")
            if tokens and tokens[-1] in UNITS:
                original_unit = tokens.pop()
                unit, scale = UNITS[original_unit]
                try:
                    original_number = spoken_number(" ".join(tokens))
                    value = str(Decimal(original_number) * Decimal(scale))
                    display = "numeric"
                except ValueError as error:
                    ambiguities.append(str(error))
            else:
                ambiguities.append("Read the value and unit explicitly, for example minus twelve point five millivolts.")
    return MeasurementCandidate(candidate_id=opaque_id(), request_id=request_id, original_text=text,
        value=value, si_unit=unit, original_unit=original_unit, original_number=original_number,
        display_state=display, source="voice", ambiguities=ambiguities)
