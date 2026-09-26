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

The prior 17m31s long-run failure remains preserved. This follow-up does not claim a new successful 20-minute run or prove that the earlier mismatch had the same cause as the newly caught mesh interpolation. Voice, microphone, physical cameras, actuators and electrical tests were not exercised. These checks did not exercise paid providers or physical equipment.

## Changed areas

Renderer changes are in `App.tsx`, `CameraWorkspace.tsx`, `journey-theme.css`, `CharacterRig.tsx` and `FrierenGuide.tsx`. Native title/icon changes are in `apps/desktop/src/main/main.cjs`. Artwork is in `apps/desktop/src/renderer/assets/journey/signpost.png`, with provenance in that folder's README. Updated desktop regressions are under `tests/end-to-end/`; `scripts/soak-camera.cjs` now samples the lower face and waist separately from intentionally blinking eyelids. README and the durable progress log point to this record.

## Trailhead and incomplete-eyelid correction

The user's next visual review identified two defects: the signs appeared in the middle of the road, and the left blink retained part of its original open-eye contour. The earlier neutral screenshot review did not catch that contour defect.

The revised `sidebar-trailhead.png` puts the post on a grassy verge, with the trail passing to its right and shaded foliage behind the boards. `journey-theme.css` removes the pale wash and keeps the scene at a fixed size so changing desktop window height cannot move the road under the post. A bottom fade extends the meadow colour on taller windows. The existing sign artwork and birch selection treatment are preserved; the old background remains in the asset folder. The exact built-in image-tool prompt and SHA-256 are recorded in the asset README.

Blinking now uses only the two artist-drawn closed-eye patches from the same character sheet, aligned separately for each open-eye pose. The masks cover the open eyeliner and iris while leaving the rest of the portrait in place. This is a localized canvas composition, not a periodic whole-body sprite swap.

The expanded three-pose review caught another alignment error in the first implementation: coordinates had been estimated from a displayed preview instead of the original 1330 × 1182 sheet. Coordinates now use the original dimensions and each frame's crop offset. Narrower source patches exclude adjacent hair; destination masks cover the entire open-eye contour and end before the lower-face guard. Neutral, thinking and stumped closed-eye captures were inspected separately. The regression forces each actual rendered pose to its blink peak and checks both eyes independently; it does not substitute a static composited preview or invoke a model.

The trailhead layout passed the visual workspace and compact workspace regressions (51.3 and 33.5 seconds), with desktop and 125%-equivalent captures inspected. The final narrowed-mask build passes TypeScript and production bundling. Final character motion verification passed in 52.3 seconds: both irises disappear in each of the three open-eye poses; the lower face retains exactly the same pixel hash before/at each blink; the upper face and waist stay anchored; outer regions move; reduced motion freezes the portrait. The final phase check passed in 17.3 seconds, sampling 2,340 simulated seconds with one hash each for upper face, lower face and waist and 14 outer-region hashes. This is accelerated phase sampling, not a new long wall-clock acceptance run.

No voice, physical camera, actuator, electrical test or paid service was used. Shared service contracts are unchanged. The earlier failed long camera session still needs a separately measured full rerun; actual hardware and voice acceptance remain pending. Changes are local, with the scenery checkpoint `33525a0` and the subsequent eyelid correction recorded in Git.
