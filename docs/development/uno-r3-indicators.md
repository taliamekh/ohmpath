# Arduino Uno R3 indicator interpretation

The selected board profile is the official Arduino Uno R3 (A000066). Arduino's
[datasheet and pinout](https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf)
and [schematic](https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf)
identify the ON power indicator, the L/D13 built-in LED, and the TX/RX USB
serial indicators. Arduino's [reset guide](https://support.arduino.cc/hc/en-us/articles/5779192727068-Reset-your-board)
explains why L may blink when the Blink sketch is loaded, but a different
sketch can leave it unlit or control it differently. Arduino's
[power-LED guidance](https://support.arduino.cc/hc/en-us/articles/360018922219-My-board-PWR-Led-does-not-turn-on)
does not treat a missing power light as proof of a particular fault.

`services/bench/src/ohmpath/devices/uno_r3_indicators.py` translates separately
observed LED states into cautious explanations and next checks. Its input
states distinguish lit, unlit, flashing, invisible, and uncertain. They also
record whether the observation came from a single image, several frames, or
a person's report; the claimed power connection; and whether the board ID is
confirmed. A single image cannot claim flashing or sustained darkness.

- **ON lit:** power appears to reach the indicator. It does not establish
  measured rail voltage or prove the MCU runs.
- **ON unlit while supposedly powered:** check the source/cable/connector and
  obtain a separate confirmed voltage reading if appropriate. An image does
  not distinguish missing power from a failed LED or board path.
- **L lit, unlit, or blinking:** the loaded sketch and observation time matter.
  It is not a firmware identity or fault code.
- **TX/RX flashing:** consistent with USB serial activity on this board; it
  does not prove that an upload completed or that the sketch works.
- **TX/RX unlit:** can be normal during an idle interval. A still image may
  simply miss a brief flash.
- **No lights seen:** ask how the board is powered, improve the view, and
  inspect more than one frame before suggesting a power-path check. Never
  treat the absence as a confirmed physical measurement.

The module produces visual candidates or user-reported observations. It
never opens a serial port, resets or flashes a board, accepts a measurement,
or operates connected hardware. The Photo Help and Live help selected-snapshot
prompts now include matching guidance so the image-capable model reports
what it can see before offering these interpretations. The module is not yet
fed structured states from those model answers; the prompts and module are
separate safeguards. There is no continuous LED tracker or physical-board
acceptance evidence yet; glare, occlusion, clone layouts, and camera exposure
can all change apparent LED state. Do not claim this works on an Uno R4 or a
clone with a different layout without a separate profile.

## Verification

The dedicated test covers dark power/all-dark cases, L off, TX/RX activity,
single-image flash rejection, unknown board/power context, and separation
between model-visible candidates and user reports. Offline prompt replays
verify that both selected-image paths carry the guidance without changing
their answer schemas. The focused runtime/indicator tests passed **44/44**;
the full bench-service suite passed **443**, with **2 skipped** and one
existing Starlette/httpx deprecation warning. A real Uno R3 image or video
sequence remains to be evaluated with the user.
