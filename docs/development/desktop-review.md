# Desktop integration review

Reviewed the current `apps/desktop/src/main/main.cjs`, `preload.cjs`,
`companion-preload.cjs`, `pi-video.cjs`, `reviewed-image.cjs`, and renderer
camera, voice, companion, aiming, pause, and shutdown paths. This review made
no production changes and did not open a camera, microphone, Pi connection,
or Electron window. The coordinator supplied completed fake-camera E2E and
Node suite results; a longer soak was still running during this review.

## Earlier findings, now resolved

- **Companion media permission:** Both Chromium permission handlers in
  `main.cjs` now require the requesting contents to be exactly
  `mainWindow.webContents`, the main frame, and the trusted URL. The companion
  may load the same built HTML, but its different web contents cannot satisfy
  these checks. The coordinator's E2E observed `NotAllowedError` for
  `navigator.getUserMedia` in the companion even while the main-window camera
  preview was live. Its preload still exposes only display state and Hide,
  with no `ohmpath` bench capability.
- **Development media origin:** The handlers now accept the exact local
  `http://127.0.0.1:5173/` origin in development mode as well as the built
  file URL, subject to the same main-window and main-frame checks. The fake
  camera E2E obtained a video element with `videoWidth > 0`.
- **Companion Hide state:** `main.cjs` emits `ohmpath:companion-closed` on the
  child window's `closed` event. `preload.cjs` exposes a scoped listener, and
  `App.tsx` clears `companionEnabled` when notified, so the Settings toggle
  follows a Hide action.
- **Hide sender frame:** `ohmpath:companion-hide` now requires both the
  companion web contents and its main frame, matching the ready handler.

## Current media and shutdown boundary

The main IPC bridge requires the main window's web contents, main frame, and
trusted URL. `enableCamera` and `enableMicrophone` set scoped Chromium grant
flags only following a trusted renderer action; the renderer now calls
`disableCamera` or `disableMicrophone` in `finally` after each capture-start
attempt. Revocation blocks later media requests without stopping an already
opened, user-requested stream. Pause, stop, and fixture selection also clear
both grants. The updated fake-camera E2E passed: a second same-main-frame
`getUserMedia` call without a new grant received `NotAllowedError`, while the
original preview remained live.

`DevicesPage.stopCamera()` stops every track and clears `video.srcObject`;
pause calls it, invalidates the pending aiming generation, clears displayed
simulation state, and disconnects Pi preview. Its camera-start path stops a
late stream if the page unmounted or the session paused. `App.tsx` cancels
voice capture, closes its audio context, and stops tracks on pause and
unmount. Aiming remains a laser-disabled simulation and is disabled while
the session is paused. The updated E2E confirmed pause cleared `srcObject`
and disabled the aiming action.

On main-window close, Electron requests quit. The `before-quit` handler
disconnects Pi preview, closes the companion, ends the bench child's stdin
lease, waits for the child's exit, and has a ten-second kill fallback. The
coordinator's updated E2E observed Electron exit code 0 and graceful backend
shutdown. The current soak is separate and its outcome is not claimed here.

The coordinator subsequently added `render-process-gone` handling that clears media grants, disconnects Pi preview and quits through the same child shutdown path. A dedicated isolated-renderer crash test passed in 4.1 seconds, with Electron exiting 0. No live model turn or physical device was opened by that test.

`PiVideoClient` connects only to loopback, validates a bounded port and token,
rejects redirects, checks camera-only health, bounds stream headers, JPEG
frames and buffers, and drops stale frames. Disconnect aborts the reader and
clears its frame. `reviewed-image.cjs` bounds PNG/JPEG size and dimensions,
decodes the chosen bitmap, checks decoded dimensions, and re-encodes pixels
before sending so original file metadata is not forwarded. The user must
select and confirm the image; this is not a physical observation claim.

## Limits

The completed camera E2E (one passed in about 1.5 minutes) used a fake camera,
not a physical webcam or Pi. Node tests (four passed) cover local logic; they
do not establish physical capture, a real Pi tunnel, or hardware safety. The
Pi preview remains a raw
temporary image, without pose/spot detection or calibration. The companion
still labels character art and voice as pending. No physical laser or motor
actuation is available in this desktop path.

## Speech callback review

Source-only review of the current `App.tsx` and `TroubleshootPage.tsx` speech
paths found no direct route from a general answer to measurement acceptance.
The general `speakLocalText` completion callback only resets the activity
indicator. The readback utterance completion callback alone calls
`acknowledgeReadback`; it checks the speech generation, session ID, active
session status, and cancellation flag first. The parent cancels local speech
when the session, circuit revision, arming epoch, request ID, or confirmation
ID changes. The bench readback endpoint also requires the exact active
confirmation ID and unexpired challenge; confirmation requires the candidate,
request, context hash, and revisions. These are source observations, not a
speaker or microphone test.

The earlier stale explanation read-aloud gap is resolved in the current
source. `App.tsx` now passes circuit revision and arming epoch to
`TroubleshootPage`. Its context reset cancels speech and an outstanding turn,
and clears the stored answer when the session, revision, or epoch changes.
The completed-answer view and read-aloud button require the answer revision
to match the current circuit; local speech is available only while the
session is active. `loadSession` also clears the previous local voice summary.
The coordinator reported a successful build for these changes; this review
did not rerun it. No speech E2E or physical audio test was run here.
