"""Local camera, board geometry, and meter-candidate primitives.

These modules do not persist images, confirm measurements, or command hardware.
"""

from .cameras import (
    CameraFrame,
    CameraSource,
    CameraStatus,
    CamoCameraSource,
    LatestFrameBuffer,
    MockCameraSource,
    PiCameraSource,
)
from .geometry import (
    BoardCalibration,
    GeometryError,
    SemanticTarget,
    TargetRegistry,
    ZoomTransform,
    apply_homography,
    homography_from_points,
    project_target,
    rotation_transform,
)
from .meter import parse_meter_candidate

__all__ = [
    "BoardCalibration", "CameraFrame", "CameraSource", "CameraStatus",
    "CamoCameraSource", "GeometryError", "LatestFrameBuffer", "MockCameraSource",
    "PiCameraSource", "SemanticTarget", "TargetRegistry", "ZoomTransform",
    "apply_homography", "homography_from_points", "parse_meter_candidate",
    "project_target", "rotation_transform",
]
