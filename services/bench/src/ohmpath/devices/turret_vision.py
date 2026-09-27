"""Measured camera-feature servoing, independent of language models and laser aiming."""
from __future__ import annotations

from copy import deepcopy
import time
import uuid

import cv2
import numpy as np

from ohmpath.vision.tracking import VisualTracker


class PointTracker:
    def __init__(self):
        self.tracker = VisualTracker()
        self.context = str(uuid.uuid4())
        self.sequence = 0
        self.last_frame = -1
        self.point = None

    def update(self, frame: dict, selected: tuple[float, float] | None = None) -> np.ndarray:
        if frame['sequence'] == self.last_frame and selected is None:
            if self.point is None:
                raise ValueError('Select a camera feature first.')
            return self.point.copy()
        image = frame['image']
        # The observation-only tracker has a bounded landscape/portrait decoder.
        # Keep normalized coordinates identical while preserving HD preview geometry.
        height, width = image.shape[:2]
        factor = min(1.0, 640 / max(height, width))
        tracked_image = cv2.resize(image, (round(width * factor), round(height * factor)), interpolation=cv2.INTER_AREA) if factor < 1 else image
        ok, encoded = cv2.imencode('.jpg', tracked_image, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            raise ValueError('Camera image could not be processed.')
        self.sequence += 1
        result = self.tracker.process(context_id=self.context, source='pi', sequence=self.sequence,
                                      image=encoded.tobytes(), point=selected, now=time.monotonic())
        if result['status'] != 'tracking' or result['target'] is None:
            self.point = None
            raise ValueError(result['message'])
        self.point = np.array([result['target']['x'] * (width - 1), result['target']['y'] * (height - 1)])
        self.last_frame = frame['sequence']
        return self.point.copy()


def fit_camera_map(samples: list[tuple[np.ndarray, np.ndarray]],
                   validation: tuple[np.ndarray, np.ndarray], *, pixel_scale: float = 1.) -> dict:
    if not np.isfinite(pixel_scale) or pixel_scale < 1:
        raise ValueError('The camera calibration scale is invalid.')
    inputs = np.array([item[0] for item in samples], dtype=float)
    outputs = np.array([item[1] for item in samples], dtype=float)
    if inputs.shape != (4, 2) or outputs.shape != (4, 2) or not np.isfinite(inputs).all() or not np.isfinite(outputs).all():
        raise ValueError('The calibration samples are incomplete.')
    validation_input, validation_output = (np.asarray(value, dtype=float) for value in validation)
    if (validation_input.shape != (2,) or validation_output.shape != (2,)
            or not np.isfinite(validation_input).all() or not np.isfinite(validation_output).all()):
        raise ValueError('The calibration validation sample is invalid.')
    if np.linalg.matrix_rank(inputs) != 2:
        raise ValueError('Calibration did not observe both axes.')
    mapping = np.linalg.lstsq(inputs, outputs, rcond=None)[0].T
    singular = np.linalg.svd(mapping, compute_uv=False)
    if singular[-1] < 0.025*pixel_scale or singular[0] / singular[-1] > 20:
        raise ValueError('The camera movement was too small or ambiguous to calibrate.')
    predictions = inputs @ mapping.T
    sample_errors = np.linalg.norm(outputs - predictions, axis=1)
    residual = float(np.max(sample_errors))
    validation_prediction = mapping @ validation_input
    held_out = float(np.linalg.norm(validation_output - validation_prediction))
    # Repeated large steps can vary modestly while still providing a useful
    # local slope. Check each step separately so a larger pitch response never
    # enlarges the yaw allowance. This fits a feedback model, not final aiming
    # precision; arrival still requires fresh observations within six pixels.
    fit_limits = np.maximum(4*pixel_scale, .125*np.linalg.norm(predictions, axis=1))
    validation_limit = max(5*pixel_scale, .2*float(np.linalg.norm(validation_prediction)))
    if np.any(sample_errors > fit_limits) or held_out > validation_limit:
        raise ValueError('Calibration was not repeatable. Check the mount and choose a clearer feature.')
    return {'matrix': mapping.tolist(), 'fit_error_px': residual, 'validation_error_px': held_out,
            'validation_limit_px': validation_limit, 'pixel_scale': pixel_scale}


def advance_camera_map(mapping: dict, before: np.ndarray, after: np.ndarray,
                       current: dict, target: dict) -> dict | None:
    """Keep the fitted neighbourhood current only after an observed valid step."""
    matrix = np.array(mapping['matrix'], dtype=float)
    step = np.array([target[axis]-current[axis] for axis in ('yaw', 'pitch')])
    observed = np.asarray(after)-np.asarray(before)
    predicted = matrix @ step
    scale = mapping.get('pixel_scale', 1.)
    if not all(np.isfinite(value).all() for value in (step, observed, predicted)):
        return None
    if np.linalg.norm(step) < .1 or np.linalg.norm(observed) < 2*scale:
        return None
    error = float(np.linalg.norm(observed-predicted))
    if (np.dot(observed, predicted) <= 0
            or error > max(5*scale, .35*np.linalg.norm(predicted))):
        return None
    # A damped secant update accommodates perspective changes without treating
    # an unobserved/blocked movement as evidence that the calibration still fits.
    updated = matrix + .25*np.outer(observed-predicted, step)/np.dot(step, step)
    singular = np.linalg.svd(updated, compute_uv=False)
    if singular[-1] < .025*scale or singular[0]/singular[-1] > 20:
        return None
    result = deepcopy(mapping)
    result.update(matrix=updated.tolist(), origin_us=dict(target), step_error_px=error)
    return result


def correction(mapping: dict, point: np.ndarray, size: tuple[int, int], current: dict,
               profile: dict, reference: tuple[float, float] = (0.5, 0.5)) -> tuple[dict, bool]:
    width, height = size
    error = np.array([(width - 1) * reference[0], (height - 1) * reference[1]]) - point
    if np.linalg.norm(error) <= 6:
        return dict(current), True
    step = 0.45 * np.linalg.solve(np.array(mapping['matrix'], dtype=float), error)
    scale = max(1.0, abs(step[0]) / 10.0, abs(step[1]) / 20.0)
    step /= scale
    target = {}
    for index, axis in enumerate(('yaw', 'pitch')):
        value = float(current[axis] + step[index])
        if value < profile[axis]['min'] or value > profile[axis]['max']:
            raise ValueError('The selected point is outside the saved travel range.')
        target[axis] = value
    return target, False
