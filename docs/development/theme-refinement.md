# Theme and idle animation follow-up

September 26, 2026. Implements the user's follow-up corrections after the afternoon handoff.

## Interface

- Main help destinations are **Live help** and **Photo help**. The large introductory Live help banner and decorative branding slogans are removed. Saved bench sessions remain available in a compact control.
- The navigation signs now share one painted wooden post. **Choose your path** sits on its own readable plank. Selected signs use pale birch shading instead of a green rectangular outline; signs alternate directions while labels remain upright.
- The desktop uses the simplified Omega-path emblem for its window icon. A wooden title strip and brown native Windows caption controls replace the black title bar. Native minimize, maximize and close controls remain supplied by Electron.
- Connection status and Measurements and circuit tools have darker, heavier headings on opaque paper panels. Remaining dark controls/cards in measurements, circuit results, calibration, troubleshooting, Devices and Settings use the same paper palette. Camera/image wells remain dark forest colours for image inspection.
- The new signpost is a reviewed raster PNG generated with the built-in image tool; its exact prompt and hash are in the journey asset README. Historical artwork is preserved. No shared service contract changed.

## Character

Idle breathing is a small vertical shoulder/chest movement, not lateral torso or hem expansion. The waist and head remain anchored. Open-eye poses blink through a local eyelid overlay without replacing the full portrait. Closed-eye expressions retain their existing artwork. Reduced motion freezes the rig.

The stricter phase regression caught ear/shoulder mesh interpolation reaching into the lower face. The motion bands now start/end at stationary mesh boundaries around the face. Neutral closed-eye artwork was visually reviewed. Thinking and stumped eye coordinates were measured from their source cells; separate live blink captures for those two expressions remain unreviewed.

## Verification

- Production build and TypeScript checks pass.
- Character motion regression passes in 28.6 seconds: localized blink, anchored upper face and waist, outer sleeve motion, all six poses and reduced-motion freeze.
- Accelerated phase regression passes in 17.3 seconds: upper face, lower face and waist each retain one pixel hash across 14 sampled paints spanning 39 simulated minutes. This is phase sampling, not 39 minutes of wall-clock testing.
- Fullscreen camera/snapshot regression passes in 46.3 seconds using synthetic video.
- Real local-service walkthrough passes in 1.4 minutes, including actual ngspice, explicit readback and simulated measurement confirmation. No physical measurement is implied.
- Three-minute silent camera interaction run passes (194 seconds including setup/cleanup): 12 advancing samples, six fullscreen cycles, five subtitle changes, three snapshot reviews, stable sampled lower face/waist and no geometry changes or renderer errors. All synthetic tracks and the private test service stopped.
- Compact offline workspace check passes in 23.3 seconds, including an inspected Settings capture at a 125%-equivalent viewport. Live help, Photo help and Devices screenshots were inspected at desktop widths.
- Final visual/compact rerun passes both scenarios in 1.4 minutes, including selected birch sign/no outline, removed slogans, heading contrast of at least 4.5:1, and expanded measurement tools. The final build also removes the unused circular decoration behind the lower companion card.

Some hidden Electron screenshot attempts timed out. Direct viewport capture and a separate compact Settings replay produced usable captures; the timeout cause remains unproven. No application behavior was weakened to make the functional assertions pass.

The prior 17m31s long-run failure remains preserved. This follow-up does not claim a new successful 20-minute run or prove that the earlier mismatch had the same cause as the newly caught mesh interpolation. Voice, microphone, physical cameras, actuators and electrical tests were not exercised. No purchases, paid fallback or additional reset occurred. Changes remain local.

## Changed areas

Renderer changes are in `App.tsx`, `CameraWorkspace.tsx`, `journey-theme.css`, `CharacterRig.tsx` and `FrierenGuide.tsx`. Native title/icon changes are in `apps/desktop/src/main/main.cjs`. Artwork is in `apps/desktop/src/renderer/assets/journey/signpost.png`, with provenance in that folder's README. Updated desktop regressions are under `tests/end-to-end/`; `scripts/soak-camera.cjs` now samples the lower face and waist separately from intentionally blinking eyelids. README and the durable progress log point to this record.
