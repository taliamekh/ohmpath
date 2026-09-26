# Frieren local expression assets

Created September 26, 2026 with Codex's **built-in image-generation tool**, using the anime reference image attached by the user. No paid API script or alternate image service was used. The original attachment and intermediate outputs remain outside this repository. These are local prototype derivatives, not a claim of officially licensed artwork or exact pixel reproduction. Public publication remains unapproved.

Reviewed selected files:

| File | Frames | SHA-256 |
| --- | --- | --- |
| `neutral.png` | Neutral, head to upper calves | `f3648278317d1ab96b2ed5b297a775d116674d6e6c21bed21f222bed20f00ae5` |
| `expressions.png` | Equal-width thinking, stumped, happy panels | `bb9f26d41ce95870ce29395d96c8c0c3b88b0e9f0ca484cc8edd1a9c3e7d2bcf` |
| `animation.png` | Equal-width blink and slightly open speaking-mouth panels | `62acc237010a2ae3e010871566ce7bad779723afc5d75e61ef719e30162dc99f` |

The renderer uses CSS frame selection, not runtime image synthesis. The neutral frame gently moves/blinks; thinking and error choose the matching face; positive user feedback chooses happy. A speaking-mouth frame is shown only during a playback activity callback. No voice was generated or played to prepare these assets. Reduced motion disables movement, blink and mouth animation.

## Generation instructions

Neutral edit: preserve the supplied Frieren face, green eyes, white/silver twin tails, pointed ears, red earrings, white/gold outfit, pose, anatomy and linework; keep the same head-to-upper-leg crop, closed neutral mouth and transparent background. Keep white hair/clothing opaque. No invented feet, chibi, 3D, text or glow.

Expression edit (neutral master reference): create three equal-width vertical panels on a 3:2 landscape canvas. Duplicate the same character, crop, pose and scale. Change only facial expression: thoughtful side glance with a small closed mouth; gently knit worried brow and puzzled closed mouth; warm modest closed-mouth smile with softened eyes. Align hair and leg cutoff. Keep transparent margins/background and opaque character, no labels or symbols.

Transparency refinement (expression-sheet reference): remove all background pixels, preserve the three figures in place and at identical coordinates/scale, keep hair/clothing/skin opaque, preserve gaps around ears/arms and between figures, and emit actual PNG alpha rather than a drawn checkerboard or solid fill. Metadata inspection confirmed zero alpha at sampled exterior pixels and opaque/near-opaque character interiors.

Animation edit (neutral master reference): create two equal-width panels on a square transparent canvas. Preserve the same character, crop, pose, outfit and scale. Left: gently closed eyes for a natural blink, original closed mouth. Right: original open green eyes with a small calm speaking mouth, no teeth or exaggerated expression. No other objects, text, scenery or panel borders.

Visual review: recognizably follows the supplied character and outfit; separate generated frames have small alignment/line differences. This is an initial expression animation, not a production Live2D rig or phoneme-level lip sync. Local desktop screenshots are kept in ignored `runtime/` and are not published.
