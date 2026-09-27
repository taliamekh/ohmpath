from __future__ import annotations

import pytest

from ohmpath.devices.uno_r3_indicators import (
    UnoR3IndicatorObservation, interpret_uno_r3_indicators,
)


def observation(**changes):
    fields = dict(board_confirmed=True, capture_kind="single_image", power_context="usb_connected",
                  on="lit", builtin_l="unlit", tx="unlit", rx="unlit")
    fields.update(changes)
    return UnoR3IndicatorObservation(**fields)


def test_unlit_power_led_and_all_dark_are_candidates_not_a_voltage_result() -> None:
    result = interpret_uno_r3_indicators(observation(on="unlit"))
    assert result.evidence_type == "visual_observation_candidate"
    assert result.confirmed_power is False and result.confirmed_firmware is False
    assert any("Possible causes" in text for text in result.possibilities)
    assert any("all four" in text for text in result.next_checks)
    assert any("supply-voltage measurement" in text for text in result.next_checks)
    assert any("idle USB serial" in text for text in result.possibilities)
    assert any("short video" in text for text in result.next_checks)


def test_power_led_on_does_not_establish_running_firmware_and_l_off_can_be_normal() -> None:
    result = interpret_uno_r3_indicators(observation())
    assert any("not that the 5 V rail is correct or the MCU is running" in text for text in result.possibilities)
    assert any("loaded sketch" in text for text in result.possibilities)
    assert any("D13" in text for text in result.next_checks)


def test_serial_flash_requires_time_evidence_and_remains_only_activity() -> None:
    with pytest.raises(ValueError, match="single image"):
        observation(tx="flashing")
    result = interpret_uno_r3_indicators(observation(capture_kind="frame_sequence", duration_s=3,
                                                       tx="flashing", rx="lit"))
    assert any("USB serial activity" in text for text in result.possibilities)
    assert all("upload completed" not in text or "does not prove" in text for text in result.possibilities)


def test_unknown_board_or_power_context_does_not_infer_a_fault() -> None:
    unknown_board = interpret_uno_r3_indicators(observation(board_confirmed=False))
    assert not unknown_board.observations and not unknown_board.possibilities
    assert "exact board identity" in unknown_board.next_checks[0]
    unknown_power = interpret_uno_r3_indicators(observation(power_context="unknown", on="unlit"))
    assert not any("Possible causes" in text for text in unknown_power.possibilities)
    assert any("Ask whether USB" in text for text in unknown_power.next_checks)
    obscured = interpret_uno_r3_indicators(observation(on="not_visible", tx="uncertain"))
    assert any("closer, well-lit view" in text for text in obscured.next_checks)


def test_user_report_is_distinct_from_visual_detection_and_invalid_states_rejected() -> None:
    result = interpret_uno_r3_indicators(observation(capture_kind="user_report"))
    assert result.evidence_type == "user_report"
    assert result.observations[0].startswith("Reported")
    with pytest.raises(ValueError, match="unsupported indicator"):
        observation(on="broken")
    with pytest.raises(ValueError, match="unsupported indicator"):
        observation(on={"untrusted": "state"})
    with pytest.raises(ValueError, match="0.5 to 60"):
        observation(capture_kind="frame_sequence", duration_s=0.1)
