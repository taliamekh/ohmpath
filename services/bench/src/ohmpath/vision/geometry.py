"""Board-to-frame geometry, independent of physical aiming calibration."""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite, sqrt
from typing import Sequence

Point = tuple[float, float]
Matrix3 = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


class GeometryError(ValueError):
    """Raised when coordinates cannot be safely projected in the current context."""


def apply_homography(matrix: Matrix3, point: Point) -> Point:
    x, y = point
    a, b, c = matrix[0]
    d, e, f = matrix[1]
    g, h, i = matrix[2]
    denominator = g * x + h * y + i
    if not isfinite(denominator) or abs(denominator) < 1e-12:
        raise GeometryError("point projects to infinity")
    result = ((a * x + b * y + c) / denominator, (d * x + e * y + f) / denominator)
    if not all(isfinite(v) for v in result):
        raise GeometryError("non-finite projection")
    return result


def homography_from_points(source: Sequence[Point], destination: Sequence[Point]) -> Matrix3:
    """Fit a projective transform from at least four board/image anchor pairs."""
    if len(source) != len(destination) or len(source) < 4:
        raise GeometryError("at least four matching anchor pairs are required")
    if not all(isfinite(v) for point in (*source, *destination) for v in point):
        raise GeometryError("anchor coordinates must be finite")
    original_source, original_destination = source, destination
    def normalize(points):
        cx = sum(p[0] for p in points) / len(points)
        cy = sum(p[1] for p in points) / len(points)
        distance = sum(hypot(p[0] - cx, p[1] - cy) for p in points) / len(points)
        if not isfinite(distance) or distance < 1e-9:
            raise GeometryError("degenerate anchor geometry")
        scale = sqrt(2) / distance
        return [(scale * (x - cx), scale * (y - cy)) for x, y in points], ((scale, 0, -scale * cx), (0, scale, -scale * cy), (0, 0, 1)), ((1 / scale, 0, cx), (0, 1 / scale, cy), (0, 0, 1))
    source, source_transform, _ = normalize(source)
    destination, _, destination_inverse = normalize(destination)
    rows: list[list[float]] = []
    values: list[float] = []
    for (x, y), (u, v) in zip(source, destination, strict=True):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        values.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        values.append(v)
    solution = _least_squares(rows, values)
    fitted = (
        (solution[0], solution[1], solution[2]),
        (solution[3], solution[4], solution[5]),
        (solution[6], solution[7], 1.0),
    )
    def multiply(left, right):
        return tuple(tuple(sum(left[r][k] * right[k][c] for k in range(3)) for c in range(3)) for r in range(3))
    fitted = multiply(destination_inverse, multiply(fitted, source_transform))
    residuals = [hypot(*(a - b for a, b in zip(apply_homography(fitted, point), expected)))
                 for point, expected in zip(original_source, original_destination, strict=True)]
    if max(residuals) > 2.0:
        raise GeometryError("anchor reprojection residual exceeds two pixels")
    return fitted


def _least_squares(rows: list[list[float]], values: list[float]) -> list[float]:
    """Small normal-equation solver; anchor sets are expected to be well-spread."""
    n = 8
    matrix = [[sum(row[i] * row[j] for row in rows) for j in range(n)] for i in range(n)]
    rhs = [sum(row[i] * value for row, value in zip(rows, values, strict=True)) for i in range(n)]
    matrix_scale = max(abs(v) for row in matrix for v in row)
    for col in range(n):
        pivot = max(range(col, n), key=lambda row: abs(matrix[row][col]))
        if abs(matrix[pivot][col]) < max(1e-12, matrix_scale * 1e-8):
            raise GeometryError("degenerate anchor geometry")
        matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
        rhs[col], rhs[pivot] = rhs[pivot], rhs[col]
        scale = matrix[col][col]
        matrix[col] = [value / scale for value in matrix[col]]
        rhs[col] /= scale
        for row in range(n):
            if row == col:
                continue
            factor = matrix[row][col]
            matrix[row] = [a - factor * b for a, b in zip(matrix[row], matrix[col], strict=True)]
            rhs[row] -= factor * rhs[col]
    return rhs


def rotation_transform(width: int, height: int, degrees: int) -> tuple[Matrix3, tuple[int, int]]:
    """Return source-pixel to clockwise-rotated-pixel transform and output size."""
    if width <= 0 or height <= 0 or degrees % 90:
        raise GeometryError("rotation requires positive dimensions and a multiple of 90 degrees")
    rotation = degrees % 360
    if rotation == 0:
        return ((1, 0, 0), (0, 1, 0), (0, 0, 1)), (width, height)
    if rotation == 90:
        return ((0, -1, height - 1), (1, 0, 0), (0, 0, 1)), (height, width)
    if rotation == 180:
        return ((-1, 0, width - 1), (0, -1, height - 1), (0, 0, 1)), (width, height)
    return ((0, 1, 0), (-1, 0, width - 1), (0, 0, 1)), (height, width)


@dataclass(frozen=True, slots=True)
class ZoomTransform:
    """UI-only crop/zoom mapping; never changes the board calibration."""

    scale: float = 1.0
    offset_x: float = 0.0
    offset_y: float = 0.0

    def __post_init__(self) -> None:
        if not isfinite(self.scale) or self.scale <= 0:
            raise GeometryError("zoom scale must be positive and finite")
        if not all(isfinite(v) for v in (self.offset_x, self.offset_y)):
            raise GeometryError("zoom offsets must be finite")

    def to_screen(self, frame_point: Point) -> Point:
        return (frame_point[0] * self.scale + self.offset_x,
                frame_point[1] * self.scale + self.offset_y)

    def from_screen(self, screen_point: Point) -> Point:
        return ((screen_point[0] - self.offset_x) / self.scale,
                (screen_point[1] - self.offset_y) / self.scale)


@dataclass(frozen=True, slots=True)
class BoardCalibration:
    camera_id: str
    board_id: str
    board_revision: str
    calibration_revision: str
    plane_id: str
    plane_depth_mm: float
    max_depth_delta_mm: float
    board_to_frame: Matrix3
    valid: bool = True
    mapping_source: str = "fiducial"
    uncertainty_mm: float | None = None

    def __post_init__(self) -> None:
        if not all((self.camera_id, self.board_id, self.board_revision,
                    self.calibration_revision, self.plane_id)):
            raise GeometryError("calibration identity and revisions are required")
        if not isfinite(self.plane_depth_mm) or not isfinite(self.max_depth_delta_mm) or self.max_depth_delta_mm < 0:
            raise GeometryError("calibration depth and tolerance must be finite")
        if len(self.board_to_frame) != 3 or any(len(row) != 3 for row in self.board_to_frame):
            raise GeometryError("calibration requires a 3 by 3 transform")
        if not all(isfinite(v) for row in self.board_to_frame for v in row):
            raise GeometryError("calibration transform must be finite")
        if self.uncertainty_mm is not None and (not isfinite(self.uncertainty_mm) or self.uncertainty_mm < 0):
            raise GeometryError("calibration uncertainty must be finite and non-negative")

    def manually_corrected(self, board_points_mm: Sequence[Point], frame_points_px: Sequence[Point],
                           *, calibration_revision: str) -> "BoardCalibration":
        """Return a new image-space mapping from user-confirmed anchor corrections."""
        return BoardCalibration(
            camera_id=self.camera_id,
            board_id=self.board_id,
            board_revision=self.board_revision,
            calibration_revision=calibration_revision,
            plane_id=self.plane_id,
            plane_depth_mm=self.plane_depth_mm,
            max_depth_delta_mm=self.max_depth_delta_mm,
            board_to_frame=homography_from_points(board_points_mm, frame_points_px),
            valid=True,
            mapping_source="manual_correction",
            uncertainty_mm=self.uncertainty_mm,
        )


@dataclass(frozen=True, slots=True)
class SemanticTarget:
    target_id: str
    board_id: str
    board_revision: str
    plane_id: str
    x_mm: float
    y_mm: float
    depth_mm: float
    linked_node_id: str | None
    calibration_revision: str
    safe_region_radius_mm: float | None = None
    uncertainty_mm: float | None = None

    def __post_init__(self) -> None:
        if not all((self.target_id, self.board_id, self.board_revision, self.plane_id, self.calibration_revision)):
            raise GeometryError("target identity and revisions are required")
        if not all(isfinite(v) for v in (self.x_mm, self.y_mm, self.depth_mm)):
            raise GeometryError("target coordinates must be finite")
        for value in (self.safe_region_radius_mm, self.uncertainty_mm):
            if value is not None and (not isfinite(value) or value < 0):
                raise GeometryError("target bounds must be finite and non-negative")


class TargetRegistry:
    """Semantic targets keyed by stable IDs with explicit revision invalidation."""

    def __init__(self) -> None:
        self._targets: dict[str, SemanticTarget] = {}
        self._board_revision: str | None = None
        self._calibration_revision: str | None = None

    def put(self, target: SemanticTarget) -> None:
        previous = self._targets.get(target.target_id)
        if previous is not None and previous != target and (previous.board_revision, previous.calibration_revision) == (target.board_revision, target.calibration_revision):
            raise GeometryError("changing a semantic target requires a new board or calibration revision")
        self._targets[target.target_id] = target

    def get(self, target_id: str) -> SemanticTarget | None:
        return self._targets.get(target_id)

    def set_context(self, *, board_revision: str, calibration_revision: str) -> None:
        self._board_revision = board_revision
        self._calibration_revision = calibration_revision

    def resolve(self, target_id: str) -> SemanticTarget:
        if self._board_revision is None or self._calibration_revision is None:
            raise GeometryError("current board and calibration context is required")
        target = self._targets.get(target_id)
        if target is None:
            raise GeometryError("unknown semantic target")
        if self._board_revision is not None and target.board_revision != self._board_revision:
            raise GeometryError("target invalidated by board revision change")
        if self._calibration_revision is not None and target.calibration_revision != self._calibration_revision:
            raise GeometryError("target invalidated by calibration revision change")
        return target

    def invalidate_board(self, board_revision: str) -> None:
        self._board_revision = board_revision

    def invalidate_calibration(self, calibration_revision: str) -> None:
        self._calibration_revision = calibration_revision


def project_target(target: SemanticTarget, calibration: BoardCalibration, *,
                   camera_id: str, board_revision: str, plane_id: str) -> Point:
    if not calibration.valid:
        raise GeometryError("board calibration is invalid")
    if camera_id != calibration.camera_id:
        raise GeometryError("calibration belongs to another camera")
    if target.board_id != calibration.board_id or board_revision != calibration.board_revision:
        raise GeometryError("board revision changed; target pose is stale")
    if target.board_revision != board_revision:
        raise GeometryError("target belongs to another board revision")
    if target.calibration_revision != calibration.calibration_revision:
        raise GeometryError("target calibration revision is stale")
    if plane_id != calibration.plane_id or target.plane_id != plane_id:
        raise GeometryError("target is on an unsupported plane")
    if abs(target.depth_mm - calibration.plane_depth_mm) > calibration.max_depth_delta_mm:
        raise GeometryError("target depth differs from calibrated plane")
    return apply_homography(calibration.board_to_frame, (target.x_mm, target.y_mm))
