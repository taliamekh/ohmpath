from ohmpath.vision import parse_meter_candidate


def parse(text, **kwargs):
    return parse_meter_candidate(text, request_id="req-1", **kwargs)


def test_signed_decimal_and_prefix_are_preserved_as_si_decimal_string():
    candidate = parse("−0.12 mV", meter_mode="DC_voltage", expected_mode="DC_voltage")
    assert candidate.value == "-0.00012"
    assert candidate.si_unit == "V"
    assert candidate.original_number == "-0.12"
    assert candidate.original_unit == "mV"
    assert candidate.source == "ocr"


def test_resistance_units_and_overload_are_candidates_only():
    ohms = parse("2.20 kΩ", meter_mode="resistance")
    assert ohms.value == "2200"
    assert ohms.si_unit == "ohm"
    overload = parse("OL", meter_mode="resistance")
    assert overload.value is None and overload.display_state == "over_limit"


def test_blank_ambiguous_missing_unit_unstable_and_mode_change_are_not_numeric():
    assert parse("", meter_mode="DC_voltage").ambiguities == ["blank_display"]
    assert parse("1.2? V", meter_mode="DC_voltage").value is None
    assert parse("1.2", meter_mode="DC_voltage").value is None
    unstable = parse("1.2 V", meter_mode="DC_voltage", unstable=True)
    assert unstable.value is None and unstable.display_state == "unstable"
    changed = parse("1.2 V", meter_mode="AC_voltage", expected_mode="DC_voltage")
    assert changed.value is None and "meter_mode_changed" in changed.ambiguities


def test_unit_and_mode_conflicts_are_rejected_and_no_candidate_is_confirmed():
    conflict = parse("1.2 V", meter_mode="resistance")
    assert conflict.value is None
    assert conflict.ambiguities == ["unit_conflicts_with_meter_mode"]
    assert not hasattr(conflict, "confirmed")


def test_prefix_case_is_not_silently_changed_by_ocr():
    assert parse("1 MΩ", meter_mode="resistance").value == "1000000"
    assert parse("1 mΩ", meter_mode="resistance").value is None
    assert parse("1 MV", meter_mode="DC_voltage").value is None


def test_overload_does_not_bypass_mode_or_stability_checks():
    assert parse("OL", meter_mode=None).ambiguities == ["meter_mode_unknown"]
    assert parse("OL", meter_mode="resistance", expected_mode="DC_voltage").ambiguities == ["meter_mode_changed"]
    assert parse("OL", meter_mode="resistance", unstable=True).display_state == "unstable"
