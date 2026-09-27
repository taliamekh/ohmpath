"""Frame one user-marked visible region using its registered planar geometry.

This module has no device or model access. It neither recognizes a circuit nor
estimates circuit extent outside the selected, initially visible rectangle.
"""
from __future__ import annotations

import math
from numbers import Real

import numpy as np

from .turret_scene import RegisteredScene


VIEW_MARGIN = 0.05


class SceneFraming:
    """Return the selected region's current bounding-box centre in full pixels.

    The centre need not itself contain trackable texture: the distributed scene
    establishes its geometry. All summary coordinates are normalized to the full
    current image and remain unclipped, so a partially visible region is explicit.
    """

    def __init__(self, frame: dict, roi: dict, margin: float = VIEW_MARGIN):
        self._initialize(RegisteredScene(frame, roi), margin)

    @classmethod
    def from_scene(cls, scene: RegisteredScene, margin: float = VIEW_MARGIN) -> SceneFraming:
        """Share an existing reference without recapturing or identifying anything."""
        if not isinstance(scene, RegisteredScene):
            raise ValueError('An existing registered scene is required for framing.')
        framing = cls.__new__(cls)
        framing._initialize(scene, margin)
        return framing

    def _initialize(self, scene: RegisteredScene, margin: float) -> None:
        if (isinstance(margin, bool) or not isinstance(margin, Real)
                or not math.isfinite(margin) or not 0 <= margin < 0.5):
            raise ValueError('The framing margin must be finite and between zero and one half.')
        self.scene = scene
        self._margin = float(margin)
        self._dimensions = np.array([self.scene.width - 1, self.scene.height - 1], dtype=float)
        self._roi = dict(scene.roi)
        # Two source pixels accommodate selection rounding, not hidden extent.
        x, y, width, height = (self._roi[key] for key in ('x', 'y', 'width', 'height'))
        tolerance = 2. / self._dimensions
        self._source_touched_edge = bool(x <= tolerance[0] or y <= tolerance[1]
                                        or x + width >= 1 - tolerance[0]
                                        or y + height >= 1 - tolerance[1])
        self._state = 'registered'
        self._message = ''
        self._centre: np.ndarray | None = None
        self._bounds: dict | None = None
        self._visible = False
        self._geometry_current = False
        self._refresh_geometry()

    def _refresh_geometry(self) -> np.ndarray:
        try:
            corners = self.scene.project_region()
        except ValueError as error:
            self._mark_lost(error)
            raise
        lower, upper = np.min(corners, axis=0), np.max(corners, axis=0)
        size = (upper - lower) / self._dimensions
        centre = (lower + upper) / 2
        normalized_lower = lower / self._dimensions
        self._bounds = {'x': float(normalized_lower[0]), 'y': float(normalized_lower[1]),
                        'width': float(size[0]), 'height': float(size[1])}
        self._centre = centre
        self._geometry_current = True
        self._visible = bool(np.all(lower >= -2.) and np.all(upper <= self._dimensions + 2.))
        # Two original-image pixels tolerate subpixel registration/rounding noise.
        if np.any(size > 1 - 2 * self._margin + 2. / self._dimensions):
            self._state = 'too_large'
            self._message = (f'The selected region is too large to fit with a {self._margin * 100:g}% margin. '
                             'Move the camera farther away or select a smaller visible region.')
            raise ValueError(self._message)
        # A partly clipped scene can still provide a trustworthy centre while
        # RegisteredScene's distributed-match and minimum-visibility checks pass.
        if np.any(centre < 0) or np.any(centre > self._dimensions):
            self._state = 'unavailable'
            self._message = 'The selected region centre has left the camera view. Select it again.'
            raise ValueError(self._message)
        self._state = 'registered'
        self._message = ('Tracking the marked visible region only. Its source selection touched an image edge; '
                         'circuit extent beyond that edge is unknown.' if self._source_touched_edge
                         else 'Tracking the marked visible region only; full circuit coverage is unverified.')
        return centre.copy()

    def _mark_lost(self, error: ValueError) -> None:
        self._state = 'lost'
        self._message = str(error)
        self._visible = False
        self._geometry_current = False

    def update(self, frame: dict) -> np.ndarray:
        try:
            self.scene.update(frame)
        except ValueError as error:
            self._mark_lost(error)
            raise
        return self._refresh_geometry()

    def summary(self) -> dict:
        # A shared component map may have updated the same scene since our last
        # update; never present stale framing bounds or a lost scene as current.
        try:
            self._refresh_geometry()
        except ValueError:
            pass
        scene = self.scene.summary()
        centre = self._centre / self._dimensions if self._centre is not None else None
        return {'state': self._state, 'message': self._message,
                'centre': {'x': float(centre[0]), 'y': float(centre[1])} if centre is not None else None,
                'bounds': dict(self._bounds) if self._bounds is not None else None,
                'selected_region_visible': self._visible,
                'geometry_current': self._geometry_current,
                'source_touched_edge': self._source_touched_edge,
                'full_circuit_coverage_verified': False,
                'fits_with_margin': self._state == 'registered',
                'margin_fraction': self._margin, 'roi': dict(self._roi),
                'generation': scene['generation'], 'sequence': scene['sequence'],
                'reference_sequence': scene['reference_sequence']}
