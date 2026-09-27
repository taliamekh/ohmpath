"""Image-only red spot candidates; no laser identity, depth or actuation authority.

The caller must associate an observation with the current stationary camera frame.
A compact red LED can look exactly like a laser spot: this module intentionally
returns a candidate, never a physical verification or permission to move/emit.
"""
from __future__ import annotations

import math
from numbers import Real

import cv2
import numpy as np


_MAX_SIDE = 1280
_SEED_DISTANCE = 0.05


def _red_mask(image: np.ndarray) -> np.ndarray:
    blue, green, red = cv2.split(image)
    other = np.maximum(blue, green).astype(np.int16)
    red = red.astype(np.int16)
    strong = (red >= 150) & (red - other >= 40) & (red >= 1.3 * other)
    # Camera exposure/white balance can render a red beam as a pale pink halo.
    # These weaker-color candidates additionally need a bright core below.
    pink = (red >= 190) & (red - green.astype(np.int16) >= 35) & (red - other >= 20) & (red >= 1.1 * other)
    # Tiny exposed cores can have only a small red excess. Preserve their pink
    # (blue above green) tint; warm white/yellow reflections do not qualify.
    pale_core = ((red >= 220) & (red - green.astype(np.int16) >= 20)
                 & (red - other >= 10) & (blue.astype(np.int16) - green.astype(np.int16) >= 8))
    return (strong | pink | pale_core).astype(np.uint8) * 255


def _seed_checked(seed: tuple[float, float] | None) -> tuple[float, float] | None:
    if seed is None:
        return None
    if not isinstance(seed, (tuple, list)) or len(seed) != 2:
        raise ValueError('Select a normalized x/y point near the red spot.')
    if any(isinstance(value, (bool, np.bool_)) or not isinstance(value, Real)
           or not np.isfinite(value) or not 0 <= value <= 1 for value in seed):
        raise ValueError('Select a normalized x/y point near the red spot.')
    return float(seed[0]), float(seed[1])


def detect_red_spot(image: np.ndarray, seed: tuple[float, float] | None = None,
                    *, seed_radius_px: float | None = None) -> dict:
    """Find a compact bright red candidate, optionally within 5% of a clicked point.

    ``image`` is a uint8 BGR frame; returned x/y use width-1 and height-1, so
    portrait and landscape have the same normalized coordinate convention.
    ``candidate_count`` counts plausible candidates over the whole frame before
    seed filtering. Similarly plausible nearby candidates are rejected rather
    than guessing which one is the laser. Radius is in original image pixels.
    ``seed_radius_px`` optionally replaces the default 5% selection radius with
    a source-image pixel distance; it requires an explicit seed and never falls
    back to an unseeded candidate when that neighbourhood is empty.
    """
    if (not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.ndim != 3
            or image.shape[2] != 3 or min(image.shape[:2]) < 16
            or max(image.shape[:2]) > 16_384 or image.shape[0] * image.shape[1] > 32_000_000):
        raise ValueError('A valid uint8 BGR camera image is required.')
    seed = _seed_checked(seed)
    height, width = image.shape[:2]
    if seed_radius_px is not None:
        if (seed is None or isinstance(seed_radius_px, (bool, np.bool_))
                or not isinstance(seed_radius_px, Real) or not np.isfinite(seed_radius_px)
                or not 0 < seed_radius_px <= max(height, width)):
            raise ValueError('A seed radius requires a selected point and a positive finite source-pixel distance within the image size.')
        seed_radius_px = float(seed_radius_px)
    scale = min(1.0, _MAX_SIDE / max(height, width))
    small = (cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))),
                        interpolation=cv2.INTER_AREA) if scale < 1 else image)
    small_height, small_width = small.shape[:2]
    scale_x, scale_y = width / small_width, height / small_height
    mask = _red_mask(small)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    max_diameter = max(12, min(small_height, small_width) * 0.065)
    for contour in contours:
        area = cv2.contourArea(contour)
        x, y, w, h = cv2.boundingRect(contour)
        if (area < 3 or max(w, h) > max_diameter or max(w, h) > 2.2 * min(w, h)
                or area > small_width * small_height * 0.002
                or x == 0 or y == 0 or x + w >= small_width or y + h >= small_height):
            continue
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / max(perimeter * perimeter, 1)
        if circularity < 0.38 or area / (w * h) < 0.3:
            continue
        roi = small[y:y+h, x:x+w]
        local_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(local_mask, [contour - (x, y)], -1, 255, cv2.FILLED)
        pixels = roi[local_mask != 0].astype(float)
        excess = np.maximum(0, pixels[:, 2] - np.maximum(pixels[:, 0], pixels[:, 1]))
        # A white/pink saturated core is permitted only inside a red component.
        white_fraction = np.mean(np.min(pixels, axis=1) >= 185)
        strong_fraction = np.mean((pixels[:,2] - np.maximum(pixels[:,0], pixels[:,1]) >= 40)
                                  & (pixels[:,2] >= 1.3 * np.maximum(pixels[:,0], pixels[:,1])))
        if strong_fraction < 0.1 and white_fraction < 0.02:
            continue
        score = (float(np.max(pixels[:, 2])) + float(np.mean(excess)) * 0.5
                 + min(float(white_fraction), 0.4) * 160) * (0.65 + 0.35 * min(1.0, circularity))
        moments = cv2.moments(contour)
        cx = ((moments['m10'] / moments['m00'] + 0.5) * scale_x - 0.5) / (width - 1)
        cy = ((moments['m01'] / moments['m00'] + 0.5) * scale_y - 0.5) / (height - 1)
        candidates.append({'contour': contour, 'score': score, 'x': cx, 'y': cy})

    # Reflections can join a small saturated core to a large, irregular red
    # bloom. Resolve compact cores separately, requiring red support around
    # them in the original pixels; brightness alone never identifies a spot.
    blue, green, red = (channel.astype(np.int16) for channel in cv2.split(small))
    bright = ((np.minimum(np.minimum(blue, green), red) >= 185) & (red >= 220)
              & (red >= .9 * blue) & (blue >= green)).astype(np.uint8) * 255
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    cores = []
    for contour in cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        area = cv2.contourArea(contour)
        x, y, w, h = cv2.boundingRect(contour)
        if (area < 3 or max(w, h) > max(8, min(small_height, small_width) * .025)
                or max(w, h) > 2.2 * min(w, h) or area / (w * h) < .3
                or x == 0 or y == 0 or x+w >= small_width or y+h >= small_height):
            continue
        circularity = 4 * math.pi * area / max(cv2.arcLength(contour, True) ** 2, 1)
        if circularity < .38:
            continue
        moments = cv2.moments(contour)
        sx, sy = moments['m10'] / moments['m00'], moments['m01'] / moments['m00']
        cx, cy = (sx + .5) * scale_x - .5, (sy + .5) * scale_y - .5
        diameter = max(w * scale_x, h * scale_y)
        radius = max(6., diameter * 1.5)
        x0, y0 = max(0, math.floor(cx-radius)), max(0, math.floor(cy-radius))
        x1, y1 = min(width, math.ceil(cx+radius+1)), min(height, math.ceil(cy+radius+1))
        rows, columns = np.indices((y1-y0, x1-x0))
        dx, dy = columns + x0 - cx, rows + y0 - cy
        distance = np.hypot(dx, dy)
        ring = (distance > diameter / 2 + 1) & (distance <= radius)
        support = (_red_mask(image[y0:y1, x0:x1]) != 0) & ring
        if np.count_nonzero(support) < max(6, .2 * np.count_nonzero(ring)):
            continue
        quadrants = sum(np.count_nonzero(support & (dx * sign_x >= 0) & (dy * sign_y >= 0)) >= 3
                        for sign_x, sign_y in ((1, 1), (1, -1), (-1, 1), (-1, -1)))
        if quadrants < 3:
            continue
        parent = next((i for i, candidate in enumerate(candidates)
                       if cv2.pointPolygonTest(candidate['contour'], (sx, sy), False) >= 0), None)
        score = (float(red[y:y+h, x:x+w].max()) + 64) * (.65 + .35 * min(1., circularity))
        cores.append((parent, {'contour': contour, 'score': score,
                               'x': cx / (width-1), 'y': cy / (height-1)}))
    # One core inside an already compact red spot is the same candidate. Two
    # separated cores remain ambiguous even if their halos touch one another.
    parent_counts = {index: sum(parent == index for parent, _ in cores) for index in range(len(candidates))}
    resolved = []
    for index, candidate in enumerate(candidates):
        if parent_counts[index] > 1:
            continue
        if parent_counts[index] == 1:
            core_candidate = next(core for parent, core in cores if parent == index)
            # Preserve halo extent as the radius, but locate the bright core;
            # even a compact asymmetric reflection can bias a halo centroid.
            candidate = {**candidate, 'contour': core_candidate['contour'],
                         'x': core_candidate['x'], 'y': core_candidate['y'],
                         'radius_px': math.sqrt(cv2.contourArea(candidate['contour']) * scale_x * scale_y / math.pi)}
        resolved.append(candidate)
    candidates = resolved
    candidates.extend(candidate for parent, candidate in cores if parent is None or parent_counts[parent] > 1)
    count = len(candidates)
    if seed is not None:
        if seed_radius_px is None:
            candidates = [candidate for candidate in candidates
                          if math.hypot(candidate['x'] - seed[0], candidate['y'] - seed[1]) <= _SEED_DISTANCE]
        else:
            candidates = [candidate for candidate in candidates
                          if math.hypot((candidate['x'] - seed[0]) * (width-1),
                                        (candidate['y'] - seed[1]) * (height-1)) <= seed_radius_px]
    if not candidates:
        raise ValueError('No clear compact red spot found' + (' near the selected point.' if seed else '.'))
    candidates.sort(key=lambda candidate: candidate['score'], reverse=True)
    if len(candidates) > 1 and candidates[1]['score'] >= candidates[0]['score'] * 0.65:
        raise ValueError('Multiple plausible red spots are visible. Select the intended spot more precisely.')

    # Refine only the selected candidate using original pixels, keeping frame
    # analysis bounded without losing the original pixel coordinate/radius units.
    contour = candidates[0]['contour'].astype(np.float64)
    contour[:, :, 0] = (contour[:, :, 0] + 0.5) * scale_x - 0.5
    contour[:, :, 1] = (contour[:, :, 1] + 0.5) * scale_y - 0.5
    contour = np.rint(contour).astype(np.int32)
    x, y, w, h = cv2.boundingRect(contour)
    roi = image[y:y+h, x:x+w].astype(np.float64)
    inside = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(inside, [contour - (x, y)], -1, 1, cv2.FILLED)
    red = roi[:, :, 2]
    excess = np.maximum(0, red - np.maximum(roi[:, :, 0], roi[:, :, 1]))
    core = np.where((np.min(roi, axis=2) >= 185) & (red >= np.max(roi, axis=2) * 0.9),
                    np.min(roi, axis=2) - 150, 0)
    weights = (excess + 2 * core) * inside
    total = float(weights.sum())
    if total <= 0:
        raise ValueError('The red spot could not be resolved in the original frame.')
    rows, columns = np.indices((h, w))
    pixel_x = float(x + (columns * weights).sum() / total)
    pixel_y = float(y + (rows * weights).sum() / total)
    if seed_radius_px is not None and math.hypot(pixel_x-seed[0]*(width-1), pixel_y-seed[1]*(height-1)) > seed_radius_px:
        raise ValueError('No clear compact red spot found near the selected point.')
    return {
        'x': pixel_x / (width - 1),
        'y': pixel_y / (height - 1),
        'radius_px': float(candidates[0].get('radius_px', math.sqrt(cv2.contourArea(contour) / math.pi))),
        'candidate_count': count,
        'source': 'red_spot_candidate',
        'physically_verified': False,
    }
