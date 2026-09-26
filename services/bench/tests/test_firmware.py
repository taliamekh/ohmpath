from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ohmpath.devices.firmware import parse_firmware_evidence


NOW = datetime(2026, 9, 26, 14, 0, tzinfo=timezone.utc)


def categories(report):
    return {item.category for item in report.hypotheses}


def test_parser_links_baud_mismatch_to_distinct_serial_and_configuration_observations():
    report = parse_firmware_evidence(
        captured_at=NOW, firmware_revision="fw-r4",
        serial_text="serial baud: 9600",
        configuration_text="SERIAL_BAUD = 115200",
    )
    hypothesis = next(item for item in report.hypotheses if item.category == "baud_mismatch")
    assert len(hypothesis.supporting_evidence_ids) == 2
    assert {item.source for item in report.observations} == {"serial", "configuration"}
    assert all(item.firmware_revision == "fw-r4" for item in report.observations)
    assert "115200" in report.checks[0].instruction
    assert hypothesis.status == "candidate"


def test_parser_distinguishes_boot_loop_pin_configuration_and_power_checks():
    report = parse_firmware_evidence(
        captured_at="2026-09-26T10:00:00-04:00", firmware_revision=None,
        serial_text="booting image\nreset reason: watchdog\nbooting image\nreset reason: watchdog\nbooting image\nGPIO pin 17 invalid\nBrownout detector triggered",
        configuration_text="LED_PIN = 17\n",
    )
    assert {"boot_loop", "pin_configuration", "power_integrity"} <= categories(report)
    pin_hyp = next(item for item in report.hypotheses if item.category == "pin_configuration")
    assert "not establish" in pin_hyp.statement
    assert any(check.hardware_action and check.requires_user_authorization for check in report.checks)
    assert all(obs.captured_at == "2026-09-26T14:00:00Z" for obs in report.observations)


def test_unmatched_configuration_is_a_check_not_a_claim_of_physical_mismatch():
    report = parse_firmware_evidence(captured_at=NOW, configuration_text="SDA_PIN = 21\nSCL_PIN = 22")
    hypothesis = next(item for item in report.hypotheses if item.category == "pin_configuration")
    assert "no physical wiring map" in hypothesis.statement
    assert "wiring map" in report.checks[0].instruction
    assert hypothesis.assumptions


def test_parser_treats_supplied_commands_as_data_and_never_returns_executable_actions():
    report = parse_firmware_evidence(captured_at=NOW,
                                     build_output="error: custom command says `del C:\\important`\n")
    assert "del C:\\important" in report.observations[0].text
    assert not hasattr(report, "commands")
    assert not report.checks
    assert report.provenance == "supplied_text_only"
    assert len(report.raw_input_sha256) == 64


def test_parser_rejects_unbounded_inputs_and_timestamps_without_timezone():
    with pytest.raises(ValueError, match="80,000"):
        parse_firmware_evidence(captured_at=NOW, serial_text="x" * 80_001)
    with pytest.raises(ValueError, match="timezone"):
        parse_firmware_evidence(captured_at=datetime(2026, 9, 26, 14, 0))
    with pytest.raises(ValueError, match="ISO-8601"):
        parse_firmware_evidence(captured_at="not a timestamp")
