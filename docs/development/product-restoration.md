# Product workspace restoration

The main product no longer includes prepared LED narration, screenshot pulse
presets, saved filming-point controls or their API routes. A separate local-only
copy preserves the requested rehearsal; it is not part of this repository.
Existing explicitly labelled circuit fixtures and aiming simulations remain
software test/practice facilities, not substitutes for real diagnosis.

The **Turret control** sidebar entry is restored. Photo help can still open the
pointer for the current test. Both entry paths retain explicit arming, current
camera/control checks, saved travel limits for automatic pointing and release
on leaving the control surface. No physical motion was performed during cleanup.

Genuine product work retained includes local speech installation discovery,
speech-status retry feedback, explicit encrypted voice-profile recovery, playback
completion/cancellation handling, camera layout simplification, external annotation
labels and leader lines, and private circuit draft reconstruction/correction.

Contract addition: `PhotoCircuitModel` and the user-only `photoCircuitStatus`
read endpoint restore a bounded unverified draft. Resistor/DC-source simulation
uses the validated local compiler; unknown or unsupported components block it.
Predictions, user reports and confirmed measurements remain separate evidence.

Verification on September 27, 2026:

- Production TypeScript/Vite build passed.
- Bench suite: 827 passed, 2 skipped; one upstream Starlette deprecation warning.
- Desktop unit suite: 103 passed, plus the production-surface regression passed.
- Generated contracts and whitespace checks passed.
- Six focused Electron interface checks passed: photo review/context restoration,
  direct Turret menu and safe navigation, speech-status retry feedback, and both
  ordinary and project-local speech installation detection. These used isolated
  test profiles and synthetic controller responses, not the user's active app.

Real microphone/speaker quality, physical target landing and a complete autonomous
diagnosis on the user's circuit are not established by these software checks.
