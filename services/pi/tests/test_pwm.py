"""Fake filesystem outputs only; never actuates hardware."""
import pytest
from ohmpath_pi import pwm


def test_driver_accepts_extended_pulses_and_validates_both_axes_before_writing(tmp_path, monkeypatch):
    writes = []
    monkeypatch.setattr(pwm, 'write', lambda path, value: writes.append((path, value)))
    driver = pwm.Pi5PWM(); driver.chip = tmp_path; driver.enabled = True
    for pair in ((500, 2500), (750, 2250), (999, 2001), (400, 2650)):
        driver.move(pair)
        assert [v for _, v in writes[-2:]] == [pair[0] * 1000, pair[1] * 1000]
    writes.clear()
    for bad in ((0, 1500), (-1, 1500), (1500, 20000), (1500, float('nan')), (1500, float('inf')), (1500, True), (1500,)):
        with pytest.raises(ValueError): driver.move(bad)
        with pytest.raises(ValueError): driver.arm(bad)
    assert writes == []
