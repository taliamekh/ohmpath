# Frieren local expression assets

Created September 26, 2026 with Codex's **built-in image-generation tool**, using the anime reference image attached by the user. No paid API script or alternate image service was used. The original attachment and intermediate outputs remain outside this repository. These are local prototype derivatives, not a claim of officially licensed artwork or exact pixel reproduction. Public publication remains unapproved.

Reviewed selected files:

| File | Frames | SHA-256 |
| --- | --- | --- |
| `neutral.png` | Neutral, head to upper calves | `f3648278317d1ab96b2ed5b297a775d116674d6e6c21bed21f222bed20f00ae5` |
| `expressions.png` | Equal-width thinking, stumped, happy panels | `bb9f26d41ce95870ce29395d96c8c0c3b88b0e9f0ca484cc8edd1a9c3e7d2bcf` |
| `animation.png` | Equal-width blink and slightly open speaking-mouth panels | `62acc237010a2ae3e010871566ce7bad779723afc5d75e61ef719e30162dc99f` |

The three files above are preserved historical artwork. Their whole-body blink/talk swaps are retired: independently generated registration caused a periodic visible pose jump.

The current renderer uses `gestures.png` (1330 × 1182, RGBA; SHA-256 `0f238c2b8e7bd3303d1d2b07f0a382d5f2d725b4aacaa7b12c73ed0db093e011`). Its 3 × 2 grid contains neutral, thinking, stumped, happy, smug and weary poses. The last two faces derive from the user's additional screenshots. Each selected pose stays fixed until its expression changes. A continuous canvas mesh animates outer arms, ears and fabric while holding the central face/torso fixed; per-column registration offsets center the heads. A tiny procedural mouth overlay is active only during an actual playback state. Reduced motion and OS motion preferences stop animation. Hidden/offscreen rigs pause. No audio was generated or played to prepare or test these assets.

## New gesture-sheet prompts

Initial generation used the historical neutral image for identity/costume and the two new anime screenshots for facial expressions: one 3-column by 2-row transparent sheet, top neutral/hand-at-chin thinking/palms-up stumped, bottom open-palmed happy/smug folded hands/weary drooped shoulders. Preserve white/silver twin tails, green eyes, elf ears, white-and-gold outfit, black collar and red jewel/earrings. Keep head-to-knee framing and exact pose registration. The first 1:2 cell layout overlapped hands across cell boundaries and was rejected.

Selected refinement prompt (the first sheet was the edit target): Use case: precise-object-edit. Edit this six-expression Frieren sprite sheet for clean production layout. Preserve all six designs, faces, arms, clothing, color and line quality. Re-layout onto a true transparent RGBA sheet in exactly 3 equal columns and 2 equal rows. Each cell now has aspect ratio 3:4 (overall image ratio9:8), providing EXTRA TRANSPARENT SIDE PADDING: every character including ALL fingers must fit INSIDE its cell with at least 8% empty margin on each left/right edge. Absolutely no overlapping adjacent cell, no clipped hands. Within each cell head centered x50%, topofhead y4%, knee cutoff y96%, identical headscale and identical standing torsoheight. Keep the six poses top neutral/thinking/palms-up stumped and bottom happy/openpalms/smughandsfolded/wearyhandsdown as seen (bottom has three poses happy,smug,weary). The bottom right weary expression must include a tiny tear/sweat droplet near outer eye as in anime. Adjust canvas layout and transparent padding, not identity or expression art. No cell borders, no labels, no text, no opaque background, no checkerboard. Exact evenly spaced grid, each subject completely separated by transparency. Maintain original high quality anime drawing.

The generator's head positions were not mathematically exact; small crop offsets register them in the renderer. This is a lightweight raster puppet with state-specific poses, not a production Live2D model, guaranteed exact reproduction, or phoneme-level lip sync.

## Generation instructions

Neutral edit: preserve the supplied Frieren face, green eyes, white/silver twin tails, pointed ears, red earrings, white/gold outfit, pose, anatomy and linework; keep the same head-to-upper-leg crop, closed neutral mouth and transparent background. Keep white hair/clothing opaque. No invented feet, chibi, 3D, text or glow.

Expression edit (neutral master reference): create three equal-width vertical panels on a 3:2 landscape canvas. Duplicate the same character, crop, pose and scale. Change only facial expression: thoughtful side glance with a small closed mouth; gently knit worried brow and puzzled closed mouth; warm modest closed-mouth smile with softened eyes. Align hair and leg cutoff. Keep transparent margins/background and opaque character, no labels or symbols.

Transparency refinement (expression-sheet reference): remove all background pixels, preserve the three figures in place and at identical coordinates/scale, keep hair/clothing/skin opaque, preserve gaps around ears/arms and between figures, and emit actual PNG alpha rather than a drawn checkerboard or solid fill. Metadata inspection confirmed zero alpha at sampled exterior pixels and opaque/near-opaque character interiors.

Animation edit (neutral master reference): create two equal-width panels on a square transparent canvas. Preserve the same character, crop, pose, outfit and scale. Left: gently closed eyes for a natural blink, original closed mouth. Right: original open green eyes with a small calm speaking mouth, no teeth or exaggerated expression. No other objects, text, scenery or panel borders.

Visual review: recognizably follows the supplied character and outfit; separate generated frames have small alignment/line differences. This is an initial expression animation, not a production Live2D rig or phoneme-level lip sync. Local desktop screenshots are kept in ignored `runtime/` and are not published.
