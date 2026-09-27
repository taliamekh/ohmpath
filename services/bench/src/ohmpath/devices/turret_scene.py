"""Local registration of one explicitly selected, approximately planar circuit scene.

This maps image points, not electrical meaning, depth, servo angles or beam position.
A lost registration stays lost: a caller must explicitly select a new reference.
"""
from __future__ import annotations

import math
from numbers import Real

import cv2
import numpy as np


MAX_SIDE = 960
MAX_FEATURES = 1200
MIN_INLIERS = 16


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError('Scene coordinates must be finite numbers.')
    return float(value)


def _frame(frame: dict) -> tuple[np.ndarray, str, int]:
    if not isinstance(frame, dict):
        raise ValueError('A camera frame is required.')
    image, generation, sequence = frame.get('image'), frame.get('generation'), frame.get('sequence')
    if (not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.ndim != 3
            or image.shape[2] != 3 or min(image.shape[:2]) < 64):
        raise ValueError('Scene registration requires a BGR camera image of at least 64 pixels per side.')
    if not isinstance(generation, str) or not generation:
        raise ValueError('The camera generation is missing.')
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise ValueError('The camera frame sequence is invalid.')
    return image, generation, sequence


def _project(transform: np.ndarray, points: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack((points, np.ones(len(points)))) @ transform.T
    if not np.isfinite(homogeneous).all() or np.any(np.abs(homogeneous[:, 2]) < 1e-8):
        raise ValueError('The circuit plane has invalid perspective.')
    return homogeneous[:, :2] / homogeneous[:, 2, None]


class RegisteredScene:
    """Track normalized reference-full-image points within a user-selected ROI.

    ``update`` consumes monotonically increasing frames from the same camera
    generation/geometry. Repeating the latest sequence uses the cached transform.
    Any failed update invalidates ``resolve`` until a new object is constructed.
    """

    def __init__(self, frame: dict, roi: dict):
        image, self.generation, self.reference_sequence = _frame(frame)
        if not isinstance(roi, dict) or set(roi) != {'x', 'y', 'width', 'height'}:
            raise ValueError('Select a circuit rectangle using x, y, width and height.')
        self.roi = {key: _number(roi[key]) for key in ('x', 'y', 'width', 'height')}
        x, y, width, height = (self.roi[key] for key in ('x', 'y', 'width', 'height'))
        if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
            raise ValueError('The selected circuit rectangle must stay inside the image.')
        self.height, self.width = image.shape[:2]
        self._corners = np.array([[x, y], [x + width, y], [x + width, y + height],
                                  [x, y + height]], dtype=float) * [self.width - 1, self.height - 1]
        if min(width * (self.width - 1), height * (self.height - 1)) < 64:
            raise ValueError('Select a larger circuit region with several distinctive details.')
        scale = min(1.0, MAX_SIDE / max(self.width, self.height))
        self._size = (round(self.width * scale), round(self.height * scale))
        sx, sy = self._size[0] / self.width, self._size[1] / self.height
        # cv2.resize uses pixel centres, including noninteger portrait scale factors.
        self._down = np.array([[sx, 0, (sx - 1) / 2], [0, sy, (sy - 1) / 2], [0, 0, 1.]])
        self._up = np.linalg.inv(self._down)
        self._small_corners = _project(self._down, self._corners)
        self._orb = cv2.ORB_create(nfeatures=MAX_FEATURES, scaleFactor=1.2, nlevels=8,
                                   edgeThreshold=15, patchSize=31, fastThreshold=12)
        gray = self._gray(image)
        mask = np.zeros(gray.shape, dtype=np.uint8)
        cv2.fillConvexPoly(mask, np.rint(self._small_corners).astype(np.int32), 255)
        keypoints, self._descriptors = self._orb.detectAndCompute(gray, mask)
        self._points = np.array([key.pt for key in keypoints], dtype=np.float32).reshape(-1, 2)
        if self._descriptors is None or len(self._points) < MIN_INLIERS:
            raise ValueError('The circuit region has too few distinctive details. Improve focus or select a larger region.')
        self._coverage(self._points)
        self._reference_gray = gray.copy()
        self._current_gray = gray.copy()
        self._small_transform = np.eye(3)
        self.sequence = self.reference_sequence
        self._transform: np.ndarray | None = np.eye(3)
        self._mapped_corners = self._corners.copy()
        self._lost: str | None = None
        self._metrics = {'matches': len(self._points), 'inliers': len(self._points),
                         'inlier_ratio': 1.0, 'reprojection_rms_px': 0.0}

    def _gray(self, image: np.ndarray) -> np.ndarray:
        # Resize before converting to gray, so feature work and memory stay bounded.
        resized = cv2.resize(image, self._size, interpolation=cv2.INTER_AREA) if image.shape[1::-1] != self._size else image
        return cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

    def _coverage(self, points: np.ndarray) -> float:
        lo, hi = self._small_corners[0], self._small_corners[2]
        dimensions = hi - lo
        normalized = (points - lo) / dimensions
        span = np.ptp(normalized, axis=0)
        hull_area = cv2.contourArea(cv2.convexHull(points.astype(np.float32)))
        coverage = hull_area / float(np.prod(dimensions))
        cells = np.clip((normalized * 3).astype(int), 0, 2)
        if (np.min(span) < 0.35 or coverage < 0.12 or len(set(map(tuple, cells))) < 4
                or len(set(cells[:, 0])) < 2 or len(set(cells[:, 1])) < 2):
            raise ValueError('Circuit matches are clustered or ambiguous. Select a region with more distributed details.')
        return coverage

    def _geometry(self, transform: np.ndarray) -> np.ndarray:
        samples = np.vstack((self._corners, np.mean(self._corners, axis=0)))
        denominator = samples @ transform[2, :2] + transform[2, 2]
        if np.any(denominator <= 0) or np.max(denominator) / np.min(denominator) > 1.6:
            raise ValueError('The circuit perspective changed too much; select a new reference.')
        projected = _project(transform, samples)
        for mapped, divisor in zip(projected, denominator):
            jacobian = (transform[:2, :2] - np.outer(mapped, transform[2, :2])) / divisor
            singular = np.linalg.svd(jacobian, compute_uv=False)
            if (np.linalg.det(jacobian) <= 0 or singular[-1] < 0.45 or singular[0] > 2.2
                    or singular[0] / singular[-1] > 1.65):
                raise ValueError('Circuit scale, shear or orientation is inconsistent with the selected plane.')
        polygon = projected[:4].astype(np.float32)
        if not cv2.isContourConvex(polygon):
            raise ValueError('The circuit region no longer forms a valid plane.')
        image_rectangle = np.array([[0, 0], [self.width - 1, 0],
                                    [self.width - 1, self.height - 1], [0, self.height - 1]], np.float32)
        visible_area, _ = cv2.intersectConvexConvex(polygon, image_rectangle)
        if visible_area / max(cv2.contourArea(polygon), 1.) < 0.6:
            raise ValueError('Too much of the registered circuit has left the camera view.')
        return projected[:4]

    def update(self, frame: dict) -> None:
        if self._lost is not None:
            raise ValueError(f'Circuit registration was lost. Select a new reference. {self._lost}')
        try:
            self._update(frame)
        except (ValueError, cv2.error, np.linalg.LinAlgError) as error:
            self._transform = None
            self._lost = str(error)
            raise ValueError(f'Circuit registration lost: {error}') from error

    def _update(self, frame: dict) -> None:
        image, generation, sequence = _frame(frame)
        if generation != self.generation or image.shape[:2] != (self.height, self.width):
            raise ValueError('Camera generation or image geometry changed.')
        if sequence < self.sequence:
            raise ValueError('The camera frame is out of order.')
        if sequence == self.sequence:
            return
        gray = self._gray(image)
        keypoints, descriptors = self._orb.detectAndCompute(gray, None)
        if descriptors is None or len(keypoints) < MIN_INLIERS:
            raise ValueError('The circuit is obscured, blurred or no longer visible.')
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        forward = matcher.knnMatch(self._descriptors, descriptors, k=2)
        reverse = matcher.knnMatch(descriptors, self._descriptors, k=2)
        reciprocal = {pair[0].queryIdx: pair[0].trainIdx for pair in reverse
                      if len(pair) == 2 and pair[0].distance < 0.78 * pair[1].distance}
        matches = [pair[0] for pair in forward if len(pair) == 2
                   and pair[0].distance < 0.72 * pair[1].distance and pair[0].distance <= 64
                   and reciprocal.get(pair[0].trainIdx) == pair[0].queryIdx]
        if len(matches) < MIN_INLIERS:
            raise ValueError('Too few unique circuit matches; the scene may be lost or ambiguous.')
        source = np.array([self._points[match.queryIdx] for match in matches], np.float32)
        target = np.array([keypoints[match.trainIdx].pt for match in matches], np.float32)
        transform, mask = cv2.findHomography(source, target, cv2.RANSAC, 2.8, maxIters=2000, confidence=0.995)
        if transform is None or mask is None or not np.isfinite(transform).all():
            raise ValueError('No consistent circuit plane could be found.')
        inliers = mask.ravel().astype(bool)
        count, ratio = int(np.sum(inliers)), float(np.mean(inliers))
        if count < MIN_INLIERS or ratio < 0.55:
            raise ValueError('Circuit matches disagree about the current plane.')
        coverage = self._coverage(source[inliers])
        errors = np.linalg.norm(_project(transform, source[inliers]) - target[inliers], axis=1)
        inverse_errors = np.linalg.norm(_project(np.linalg.inv(transform), target[inliers]) - source[inliers], axis=1)
        if (np.sqrt(np.mean(errors ** 2)) > 2.0 or np.percentile(errors, 95) > 3.0
                or np.percentile(inverse_errors, 95) > 3.5):
            raise ValueError('Circuit registration is not precise enough for point placement.')
        original = self._up @ transform @ self._down
        if abs(original[2, 2]) < 1e-8:
            raise ValueError('The circuit plane has invalid perspective.')
        original /= original[2, 2]
        mapped_corners = self._geometry(original)
        # Publish state only after every validation succeeds.
        self._transform = original
        self._small_transform = transform.copy()
        self._current_gray = gray.copy()
        self._mapped_corners = mapped_corners
        self.sequence = sequence
        full_errors = _project(self._up, _project(transform, source[inliers])) - _project(self._up, target[inliers])
        self._metrics = {'matches': len(matches), 'inliers': count, 'inlier_ratio': ratio,
                         'reference_coverage': coverage,
                         'reprojection_rms_px': float(np.sqrt(np.mean(np.sum(full_errors ** 2, axis=1))))}

    def project_region(self) -> np.ndarray:
        """Return validated ROI corners in current pixels, including off-image corners.

        This geometry supports view framing only; it does not authorize targets
        outside the image. ``resolve`` and ``verify_point`` retain those checks.
        """
        if self._transform is None or self._lost is not None:
            raise ValueError('Circuit registration is lost. Select a new reference.')
        return self._mapped_corners.copy()

    def resolve(self, x: float, y: float) -> np.ndarray:
        if self._transform is None or self._lost is not None:
            raise ValueError('Circuit registration is lost. Select a new reference.')
        x, y = _number(x), _number(y)
        left, top, width, height = (self.roi[key] for key in ('x', 'y', 'width', 'height'))
        if not (left <= x <= left + width and top <= y <= top + height):
            raise ValueError('The target lies outside the selected reference circuit region.')
        point = _project(self._transform, np.array([[x * (self.width - 1), y * (self.height - 1)]]))[0]
        if not (0 <= point[0] <= self.width - 1 and 0 <= point[1] <= self.height - 1):
            raise ValueError('The selected target is outside the current camera image.')
        if cv2.pointPolygonTest(self._mapped_corners.astype(np.float32), tuple(point), True) < -0.01:
            raise ValueError('The selected target is outside the currently registered circuit region.')
        return point.copy()

    def verify_point(self, x: float, y: float) -> np.ndarray:
        """Require local appearance consistency as well as valid scene geometry.

        This rejects many removed/moved targets, but cannot establish component
        identity or detect every small change against a textured background.
        Both a 56-pixel outer patch and a 28-pixel central patch are checked at
        the bounded working resolution; patches near the ROI edge are clipped.
        """
        point = self.resolve(x, y)
        reference = np.array([[float(x) * (self.width - 1), float(y) * (self.height - 1)]])
        center = _project(self._down, reference)[0]
        for radius, threshold in ((28, 0.70), (14, 0.65)):
            left = max(int(math.floor(center[0] - radius)), int(math.ceil(self._small_corners[0, 0])), 0)
            top = max(int(math.floor(center[1] - radius)), int(math.ceil(self._small_corners[0, 1])), 0)
            right = min(int(math.ceil(center[0] + radius)), int(math.floor(self._small_corners[2, 0])) + 1,
                        self._size[0])
            bottom = min(int(math.ceil(center[1] + radius)), int(math.floor(self._small_corners[2, 1])) + 1,
                         self._size[1])
            if min(right - left, bottom - top) < 16:
                raise ValueError('The target is too close to the circuit edge to verify its appearance.')
            corners = np.array([[left, top], [right - 1, top], [right - 1, bottom - 1], [left, bottom - 1]])
            current_corners = _project(self._small_transform, corners)
            if (np.any(current_corners < 0) or np.any(current_corners[:, 0] > self._size[0] - 1)
                    or np.any(current_corners[:, 1] > self._size[1] - 1)):
                raise ValueError('The target neighborhood is outside the current camera image.')
            to_patch = np.array([[1., 0, -left], [0, 1., -top], [0, 0, 1.]])
            current = cv2.warpPerspective(self._current_gray, to_patch @ np.linalg.inv(self._small_transform),
                                          (right - left, bottom - top), flags=cv2.INTER_LINEAR)
            original = self._reference_gray[top:bottom, left:right]
            # Small blur tolerates resampling noise without making blank patches valid.
            a = cv2.GaussianBlur(original, (3, 3), 0).astype(float)
            b = cv2.GaussianBlur(current, (3, 3), 0).astype(float)
            if min(float(a.std()), float(b.std())) < 6.0:
                raise ValueError('The target lacks enough local texture to verify its position.')
            a -= a.mean()
            b -= b.mean()
            correlation = float(np.sum(a * b) / math.sqrt(float(np.sum(a * a) * np.sum(b * b))))
            if correlation < threshold:
                raise ValueError('The selected component appearance changed or is obscured; select it again.')
        return point

    def summary(self) -> dict:
        return {'state': 'lost' if self._lost else 'registered', 'generation': self.generation,
                'reference_sequence': self.reference_sequence, 'sequence': self.sequence,
                'width': self.width, 'height': self.height, 'roi': dict(self.roi),
                'message': self._lost, **self._metrics}
