"""Opt-in Raspberry Pi 5 servo PWM. Importing this module does not access hardware."""
from __future__ import annotations

from pathlib import Path
import math
import subprocess
import time

PINS = ((12, 0), (13, 1))
PERIOD_NS = 20_000_000
# PWM-format validation only. No assumed servo/mechanical travel envelope.
# A high pulse must be positive and shorter than the fixed 50 Hz frame.
MIN_PULSE_US = 1
MAX_PULSE_US = PERIOD_NS // 1000 - 1


def checked_positions(positions):
    if not isinstance(positions, (tuple, list)) or len(positions) != 2 or any(
        type(pulse) not in (int, float) or not math.isfinite(pulse)
        or not MIN_PULSE_US <= pulse <= MAX_PULSE_US for pulse in positions
    ):
        raise ValueError('Pulse cannot be represented: each 50 Hz high pulse must be positive, finite and shorter than 20000 µs.')
    return tuple(positions)


def run(*args: str) -> str:
    return subprocess.check_output(args, text=True, timeout=2, stderr=subprocess.DEVNULL).strip()


def pwm_chip() -> Path:
    chips = [p for p in Path('/sys/class/pwm').glob('pwmchip*')
             if p.resolve().parent.parent.name == '1f00098000.pwm']
    if len(chips) != 1:
        raise RuntimeError('The Raspberry Pi 5 PWM controller is unavailable.')
    return chips[0]


def write(path: Path, value: int | str) -> None:
    path.write_text(str(value), encoding='ascii')


def release_outputs() -> None:
    """Independent process cleanup also detaches pins if a PWM write fails."""
    errors = []
    try:
        chip = pwm_chip()
    except RuntimeError:
        chip = None
    for gpio, index in PINS:
        channel = chip / f'pwm{index}' if chip else None
        if channel and channel.exists():
            for name in ('duty_cycle', 'enable'):
                try:
                    write(channel / name, 0)
                except OSError as exc:
                    errors.append(str(exc))
        try:
            run('pinctrl', 'set', str(gpio), 'ip', 'pd')
        except Exception as exc:
            errors.append(str(exc))
    if errors:
        raise RuntimeError('Servo signal cleanup failed: ' + '; '.join(errors))


class Pi5PWM:
    def __init__(self) -> None:
        self.chip: Path | None = None
        self.enabled = False

    def prepare(self) -> None:
        if not Path('/proc/device-tree/model').read_text().startswith('Raspberry Pi 5'):
            raise RuntimeError('This physical driver supports Raspberry Pi 5 only.')
        budget = int.from_bytes(Path('/proc/device-tree/chosen/power/max_current').read_bytes(), 'big')
        if budget < 5000:
            raise RuntimeError('The reviewed setup requires the detected 5 A supply.')
        if not list(Path('/sys/class/pwm').glob('pwmchip*')):
            run('dtoverlay', 'pwm-2chan', 'pin=12', 'func=4', 'pin2=13', 'func2=4')
        self.chip = pwm_chip()
        if (self.chip / 'npwm').read_text().strip() != '4':
            raise RuntimeError('Unexpected PWM controller.')
        for _, index in PINS:
            channel = self.chip / f'pwm{index}'
            if channel.exists():
                if (channel / 'enable').read_text().strip() != '0':
                    raise RuntimeError('A servo output is already active; release it first.')
                write(channel / 'duty_cycle', 0)
            else:
                write(self.chip / 'export', index)
                for _ in range(100):
                    if channel.exists():
                        break
                    time.sleep(0.005)
            write(channel / 'enable', 0)
            write(channel / 'duty_cycle', 0)
            write(channel / 'period', PERIOD_NS)
            write(channel / 'polarity', 'normal')
        self.release()

    def power_flags(self) -> int:
        return int(run('vcgencmd', 'get_throttled').split('=')[1], 16)

    def arm(self, positions: tuple[float, float]) -> None:
        positions = checked_positions(positions)
        if self.chip is None:
            raise RuntimeError('PWM was not prepared.')
        try:
            for (gpio, index), pulse in zip(PINS, positions):
                run('pinctrl', 'set', str(gpio), 'a0')
                state = run('pinctrl', 'get', str(gpio))
                if f'PWM0_CHAN{index}' not in state:
                    raise RuntimeError('Servo pin function did not match the wiring profile.')
                write(self.chip / f'pwm{index}' / 'duty_cycle', round(pulse * 1000))
            for _, index in PINS:
                write(self.chip / f'pwm{index}' / 'enable', 1)
            self.enabled = True
        except Exception:
            self.release()
            raise

    def move(self, positions: tuple[float, float]) -> None:
        positions = checked_positions(positions)
        if not self.enabled or self.chip is None:
            raise RuntimeError('Servo outputs are released.')
        for (_, index), pulse in zip(PINS, positions):
            write(self.chip / f'pwm{index}' / 'duty_cycle', round(pulse * 1000))

    def release(self) -> None:
        self.enabled = False
        release_outputs()
