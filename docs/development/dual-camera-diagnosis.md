# Dual camera and image diagnosis checkpoint

Live help can display the overhead phone or Windows camera and the paired Pi
camera together. **Connect paired Pi camera** uses the existing local-user
turret connection in a released state; no movement or laser command is issued.
The older token-based video tunnel remains available under **Use an existing
video tunnel**. Connecting either Pi path while the overhead feed is live
selects Both automatically. A snapshot still requires an explicit Ask action.
The user can capture the overhead view, return to the camera, capture the Pi
view, and ask Photo help with both original images. Preview frames are not
submitted continuously.

After a renderer refresh, a previously connected desktop page offers a new
session automatically. The still-open phone page retains its camera track and
answers that offer without another tap. Explicit Disconnect/Stop ends capture.
A full desktop process restart changes the QR capability and still requires
the phone to open the new link; locking or hiding the phone page also ends
capture.
The Live help workspace stays mounted when the user opens another app tab, so
Photo help and Turret navigation leave the overhead phone camera connected.
Entering Turret releases the Live help Pi connection before turret controls
use that paired device.
The snapshot review drawer sits above camera controls so its Back to camera
button remains clickable while the preview and push-to-talk control are live.

The overhead display estimates a board's in-plane angle from visible straight
edges in a compact textured region, then rotates the displayed feed when two
successive estimates agree. Tracking and manual selection rotate with it;
snapshot pixels remain the original camera image so annotations use stable
coordinates. If the board region or its angle is unclear, the view remains
unrotated and offers lighting/occlusion guidance. This does not correct
perspective, optical focus, hidden wiring, or electrical connectivity.

Photo reasoning now asks for visible observations, conditional fault
possibilities, specific obscured details and practical ways to reveal them.
Image limitations are shown beside the main answer. Known model/transport
failures have more specific recovery messages. The model cannot confirm a
voltage, continuity, component value or repair from images alone.

## Verification

- Production TypeScript/Vite build: passed after the final alignment fallback.
- Paired Pi plus overhead synthetic Electron workflow: passed, including both
  simultaneous previews, separate snapshots, fullscreen, disconnection, and
  displayed straightening of a synthetic tilted board.
- Portrait phone close-up Electron workflow: passed; full snapshot remains
  available after the reversible crop.
- Phone WebRTC Electron workflow: passed across a renderer reload without a
  second phone camera permission request, and across Photo help navigation
  without replacing the session; explicit Stop still ends capture.
- Dual-camera workflow: Photo help navigation kept the overhead stream alive;
  Turret navigation released the Live help Pi connection while the overhead
  stream stayed live.
- The phone WebRTC workflow also passed after the review drawer stacking fix,
  including a second explicit phone session after Stop.
- Overhead-angle unit checks: passed for clear boards tilted both ways, a
  smaller portrait board, and unavailable-angle cases including a lone cable.
- Legacy Pi replay recovery workflow: passed after targeting its error message.
- Photo help runtime/service tests: 32 passed with one existing deprecation
  warning.
- Preset diagnosis, KiCad and ngspice tests: 41 passed using actual local
  simulation; no physical circuit was measured.
- Live desktop check: the direct phone feed showed the full breadboard and
  ELEGOO UNO R3 at 1080 × 1920 while the paired Pi feed delivered current
  720 × 1280 frames. Both were visible simultaneously. Camo Studio had shown
  only a grey placeholder, so the direct phone path supplied the overhead view.
- After a renderer refresh, the crooked real phone view reported a stable 13°
  display correction. Selecting a board close-up enlarged the board while the
  display stayed straight and the Pi frame stayed live. The saved snapshot
  remains the original pixels, as stated in the UI.
- A real two-image Photo help request completed through the signed-in reasoning
  route. The response identified the UNO-compatible board and breadboard,
  described likely visible jumpers and resistors, declined to name a specific
  fault, explained that the Pi image clipped wiring and the overhead labels
  were too small, and suggested sharper endpoint views plus power-off
  continuity/resistance checks. This is visual reasoning, not a confirmed
  connection trace or physical diagnosis.

## Outstanding acceptance

The user confirmed the breadboard is intended to match the bundled `divider`
fixture: three 10 kΩ resistors in series. Power is disconnected. This gives
the photo review a concrete expected topology, but the visible wire endpoints
and resistor values still need confirmation; fixture simulation is not a
measurement of the breadboard.

After the final app restart, Live help again showed the direct phone preview
at 1080 × 1920 and a current paired Pi frame at the same time; the overhead
display reported a 16° straightening. The restart required a new phone QR.

The live Pi view still clips some wire endpoints, so capture a full close-up
before expecting a specific fault or circuit-function conclusion. The divider
should be photographed with readable endpoints, then tested against a
separately confirmed measurement and a post-repair retest. The
current two-image answer is evidence that the application can identify visible
hardware and explain insufficient evidence; it does not establish that it can
diagnose an arbitrary physical fault from images alone.
