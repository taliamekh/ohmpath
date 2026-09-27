"""Evidence-limited interpretation of Arduino Uno R3 indicator observations.

This module never opens a camera or serial port. An image recognizer may supply
candidate states, but visual candidates are not voltage or firmware evidence.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal


IndicatorState = Literal["lit", "unlit", "flashing", "not_visible", "uncertain"]
CaptureKind = Literal["single_image", "frame_sequence", "user_report"]
PowerContext = Literal["usb_connected", "external_connected", "disconnected", "unknown"]

_STATES = {"lit", "unlit", "flashing", "not_visible", "uncertain"}
_POWER = {"usb_connected", "external_connected", "disconnected", "unknown"}
_CAPTURE = {"single_image", "frame_sequence", "user_report"}

PHOTO_GUIDANCE = (
    "For an Arduino Uno R3 indicator question, first establish whether the board and "
    "ON, L, TX, and RX labels are actually visible. Report each light as visibly lit, "
    "not visibly lit, or not visible/uncertain in the selected image. A single photo "
    "cannot establish blinking or sustained absence. ON indicates the power indicator, "
    "L is the sketch-controlled built-in D13 LED, and TX/RX indicate USB serial "
    "activity; idle TX/RX and an unlit L do not prove a fault. Ask how the board is "
    "powered before discussing an unlit ON indicator. Do not claim the image proves "
    "supply voltage, successful firmware execution, or a damaged board."
)


@dataclass(frozen=True)
class UnoR3IndicatorObservation:
    board_confirmed: bool
    capture_kind: CaptureKind
    power_context: PowerContext
    on: IndicatorState
    builtin_l: IndicatorState
    tx: IndicatorState
    rx: IndicatorState
    duration_s: float = 0.0

    def __post_init__(self) -> None:
        if type(self.board_confirmed) is not bool:
            raise ValueError("board_confirmed must be explicit")
        if (not isinstance(self.capture_kind, str) or self.capture_kind not in _CAPTURE
                or not isinstance(self.power_context, str) or self.power_context not in _POWER):
            raise ValueError("unsupported capture or power context")
        if any(not isinstance(state, str) or state not in _STATES
               for state in (self.on, self.builtin_l, self.tx, self.rx)):
            raise ValueError("unsupported indicator state")
        if isinstance(self.duration_s, bool) or not isinstance(self.duration_s, (int, float)) or not math.isfinite(self.duration_s):
            raise ValueError("duration_s must be finite")
        if self.capture_kind == "frame_sequence":
            if not 0.5 <= self.duration_s <= 60:
                raise ValueError("frame sequences must cover 0.5 to 60 seconds")
        elif self.duration_s != 0 or (self.capture_kind == "single_image" and "flashing" in (self.on, self.builtin_l, self.tx, self.rx)):
            raise ValueError("a single image or user report cannot carry a measured flash interval")


@dataclass(frozen=True)
class UnoR3IndicatorInterpretation:
    board_profile: Literal["arduino_uno_r3"]
    evidence_type: Literal["visual_observation_candidate", "user_report"]
    observations: tuple[str, ...]
    possibilities: tuple[str, ...]
    next_checks: tuple[str, ...]
    confirmed_power: bool = False
    confirmed_firmware: bool = False


def interpret_uno_r3_indicators(observation: UnoR3IndicatorObservation) -> UnoR3IndicatorInterpretation:
    """Turn selected LED states into cautious, evidence-labelled explanations."""
    source = "user_report" if observation.capture_kind == "user_report" else "visual_observation_candidate"
    if not observation.board_confirmed:
        return UnoR3IndicatorInterpretation(
            "arduino_uno_r3", source, (), (),
            ("Confirm the exact board identity and the printed LED labels before applying Uno R3 meanings.",),
        )

    names = (("ON", observation.on), ("L", observation.builtin_l),
             ("TX", observation.tx), ("RX", observation.rx))
    verb = "Reported" if source == "user_report" else "Seen"
    observations = tuple(f"{verb} {name}: {state.replace('_', ' ')}."
                         for name, state in names)
    possibilities: list[str] = []
    checks: list[str] = []
    expected_power = observation.power_context in {"usb_connected", "external_connected"}

    if any(state in {"not_visible", "uncertain"} for _, state in names):
        checks.append("Get a closer, well-lit view that shows the printed ON, L, TX, and RX labels before assigning states to obscured indicators.")

    if observation.on == "lit":
        possibilities.append("The ON indicator is illuminated; this suggests power reaches the indicator, not that the 5 V rail is correct or the MCU is running.")
    elif observation.on == "flashing":
        possibilities.append("The ON indicator was reported or observed changing; this does not establish a stable supply or a specific power fault.")
        checks.append("Observe the ON indicator over a longer interval and verify the power connection before interpreting the change.")
    elif observation.on == "unlit":
        if expected_power:
            possibilities.append("The ON indicator was not visibly lit despite a reported power connection. Possible causes include the source, cable, connector, power path, or indicator itself; the image cannot identify which.")
            checks.append("Confirm the stated USB or external source and inspect the cable/connector with the board's external circuit disconnected when safe.")
            checks.append("If appropriate, request a separate supervised supply-voltage measurement with explicit probe setup and readback.")
        elif observation.power_context == "disconnected":
            possibilities.append("An unlit ON indicator is expected with both power sources disconnected.")
        else:
            checks.append("Ask whether USB or an external supply is connected before interpreting the unlit ON indicator.")

    if observation.builtin_l in {"lit", "flashing", "unlit"}:
        possibilities.append("L is the built-in LED on digital pin 13; its state depends on the loaded sketch and moment of observation, so it does not by itself identify the firmware or a fault.")
        if observation.builtin_l == "unlit":
            checks.append("Ask what the deployed sketch is expected to do with D13 before treating an unlit L as abnormal.")

    if any(state in {"lit", "flashing"} for state in (observation.tx, observation.rx)):
        possibilities.append("TX/RX illumination is consistent with USB serial activity on an Uno R3; it does not prove an upload completed or that the application sketch is healthy.")
    elif observation.tx == observation.rx == "unlit":
        interval = "during the observed interval" if observation.capture_kind == "frame_sequence" else "in this moment or report"
        possibilities.append(f"No TX/RX light was observed {interval}; an idle USB serial link can look this way.")

    if all(state == "unlit" for _, state in names) and expected_power:
        checks.append("Because all four indicators appear unlit, obtain a clearer view or repeated observation and verify the power source before concluding the board is unpowered.")
    if observation.capture_kind == "single_image":
        checks.append("Use a short video or repeated frames to distinguish blinking from a light that happened to be unlit in one photo.")
    return UnoR3IndicatorInterpretation(
        "arduino_uno_r3", source, observations, tuple(possibilities), tuple(dict.fromkeys(checks)),
    )
