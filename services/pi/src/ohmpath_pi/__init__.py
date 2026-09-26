"""Dry-run-first Pi control and camera service primitives.

Importing this package never opens a camera, GPIO pin, PWM output, socket, or device.
"""

from .controller import CrosshairController, run_aim_demo
from .camera import LatestFrameBuffer, PiCameraCapture
from .models import AimObservation, ControllerConfig, ControllerResult, LocalCalibration
from .loopback import create_loopback_server
from .service import MockMotorDriver, PiControlService

__all__ = [
    "AimObservation",
    "ControllerConfig",
    "ControllerResult",
    "CrosshairController",
    "run_aim_demo",
    "create_loopback_server",
    "LocalCalibration",
    "LatestFrameBuffer",
    "PiCameraCapture",
    "MockMotorDriver",
    "PiControlService",
]
