"""Visual diagnostic candidates and conservative local circuit-area discovery.

No device operations live here. A diagnostic annotation is a suspected issue or
test location, never a confirmed electrical finding or a servo instruction.
"""
from __future__ import annotations

import math
import uuid

import cv2
import numpy as np

from .turret_targets import ComponentMap
from .turret_scene import RegisteredScene


DIAGNOSIS_INSTRUCTIONS = (
    'Help diagnose the visible circuit in this crop using the user question below. '
    'Explain what is directly visible separately from suspected faults and unverified connections. '
    'Return up to eight annotations ONLY for visible suspected problem areas or useful next-test locations, '
    'ordered from the highest diagnostic priority to the lowest. Do not make a general inventory of components. '
    'Use short labels such as "Inspect: ..." or "Test: ..." and place each point on a distinctive visible body '
    'detail near the issue. Prefer a nearby textured detail over an indistinguishable hole or reflection. '
    'Give practical next_steps and limitations. Do not claim measured values or confirm electrical continuity from a photo. '
    'If a test location or fault cannot be located visibly, explain that and return an empty annotations list; never guess a point. '
    'Ignore people, laser spots and reflections as targets. Do not provide servo values, motion commands, '
    'laser instructions, or hardware permissions. The annotations are image observations only. '
    '\nUser question (context for diagnosis):\n'
)


def diagnosis_prompt(question: str) -> str:
    if not isinstance(question, str) or not question.strip() or len(question) > 4000:
        raise ValueError('Describe the circuit question in 1 to 4000 characters.')
    question = question.strip()
    budget = 4000 - len(DIAGNOSIS_INSTRUCTIONS)
    if len(question) > budget:
        marker = '\n[Question shortened to fit this image request]\n'
        available = budget - len(marker)
        prefix = available * 2 // 3
        question = question[:prefix] + marker + question[-(available - prefix):]
    return DIAGNOSIS_INSTRUCTIONS + question


class DiagnosisMap(ComponentMap):
    """A Start-authorized diagnostic plan, validated locally without another review.

    The caller owns the existing Start authorization. Becoming ready only makes
    candidates available; it never starts a worker or sends movement commands.
    """

    def __init__(self, frame, roi, context, identifier, question):
        diagnosis_prompt(question)
        self.question = question.strip()
        self.explanation = ''
        self.next_steps = []
        self.limitations = []
        self.source_roi = dict(roi)
        super().__init__(frame, roi, context, identifier)
        self.message = 'Examining the selected circuit for visible problem areas and useful tests…'

    def _start_request(self, jpeg):
        return self.identifier.start_diagnosis(self.map_id, self.image_id, jpeg, self.question)

    def _make_scene(self, frame, roi):
        """Freeze image evidence without treating its whole background as a plane."""
        image, generation, sequence = self._frame_identity(frame)
        if not isinstance(roi, dict) or set(roi) != {'x', 'y', 'width', 'height'}:
            raise ValueError('Select a visible circuit rectangle.')
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in roi.values()):
            raise ValueError('Circuit region coordinates must be finite numbers.')
        x, y, width, height = (roi[key] for key in ('x', 'y', 'width', 'height'))
        if (x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1
                or min(width * (image.shape[1] - 1), height * (image.shape[0] - 1)) < 64):
            raise ValueError('The visible circuit region must stay within the image and be at least 64 pixels per side.')
        self._reference_frame = {'image': image.copy(), 'generation': generation, 'sequence': sequence}
        self._latest_sequence = sequence
        return None

    @staticmethod
    def _frame_identity(frame):
        if not isinstance(frame, dict):
            raise ValueError('A camera frame is required.')
        image, generation, sequence = frame.get('image'), frame.get('generation'), frame.get('sequence')
        if (not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.ndim != 3
                or image.shape[2] != 3 or min(image.shape[:2]) < 64):
            raise ValueError('A valid BGR camera image is required.')
        if not isinstance(generation, str) or not generation:
            raise ValueError('The camera generation is missing.')
        if type(sequence) is not int or sequence < 0:
            raise ValueError('The camera frame sequence is invalid.')
        return image, generation, sequence

    def update(self, frame, context):
        if self.phase in ('lost', 'cancelled', 'failed'):
            return
        try:
            image, generation, sequence = self._frame_identity(frame)
            if (context != self.context or generation != self.generation
                    or image.shape[:2] != (self.height, self.width)):
                raise ValueError('Camera or travel settings changed. Diagnose the circuit again.')
            if sequence < self._latest_sequence:
                raise ValueError('The diagnosis camera frame is out of order.')
            self._latest_sequence = sequence
            if self.phase == 'identifying':
                result = self.identifier.status(self.turn_id)
                if result['status'] == 'completed':
                    self._accept_answer(result['answer'], frame)
                elif result['status'] != 'running':
                    self.phase = 'failed'
                    self.message = result.get('message', 'Diagnosis was cancelled. Try again.')
            elif self.scene is not None:
                self.scene.update(frame)
        except ValueError as error:
            self.lose(str(error))

    def _accept_answer(self, answer, current_frame=None):
        # PhotoHelp already validates its complete answer schema. Retain the
        # explanation even if the locations subsequently fail local validation.
        self.explanation = str(answer.get('explanation', ''))
        self.next_steps = list(answer.get('next_steps', []))
        self.limitations = list(answer.get('limitations', []))
        x0, y0, x1, y1 = self.crop
        candidates = []
        for item in answer['annotations'][:8]:
            if item['image_id'] != self.image_id:
                raise ValueError('Diagnosis refers to an old camera snapshot.')
            if any(type(item[key]) not in (int, float) or not math.isfinite(item[key])
                   or not 0 <= item[key] <= 1 for key in ('x', 'y')):
                raise ValueError('Diagnosis returned invalid target positions.')
            candidates.append({'id': str(uuid.uuid4()), 'label': item['label'],
                               'x': (x0 + item['x'] * (x1 - x0 - 1)) / (self.width - 1),
                               'y': (y0 + item['y'] * (y1 - y0 - 1)) / (self.height - 1)})
        if not candidates:
            self.components = []
            self.phase = 'no_targets'
            self.message = 'Diagnosis received, but no visible issue or test location was identified.'
            return
        try:
            dimensions = np.array([self.width - 1, self.height - 1], dtype=float)
            points = np.array([[item['x'], item['y']] for item in candidates]) * dimensions
            region = _region_for_points(points, dimensions)
            scene = RegisteredScene(self._reference_frame, region)
            scene.update(current_frame if current_frame is not None else self._reference_frame)
            for component in candidates:
                scene.verify_point(component['x'], component['y'])
        except ValueError as error:
            self.phase = 'failed'
            self.approved = False
            self.message = f'Diagnosis received, but its target could not be located reliably: {error}'
            return
        self.scene, self.components, self.roi = scene, candidates, region
        self.phase = 'ready'
        self.approved = True
        self.message = 'Visible diagnostic targets are ready in priority order.'

    def summary(self):
        value = super().summary()
        value.update({'kind': 'diagnosis', 'question': self.question,
                      'explanation': self.explanation, 'next_steps': list(self.next_steps),
                      'limitations': list(self.limitations), 'evidence_kind': 'visual_diagnosis_candidates',
                      'answer': {'explanation': self.explanation, 'next_steps': list(self.next_steps),
                                 'limitations': list(self.limitations)},
                      'source_roi': dict(self.source_roi), 'source_sequence': self.source_sequence,
                      'registration_reference_sequence': self.scene.reference_sequence if self.scene is not None else None,
                      'question_truncated_for_model': len(DIAGNOSIS_INSTRUCTIONS) + len(self.question) > 4000})
        return value

    def reanchor(self, frame, context, roi=None) -> None:
        """Rebase accepted target coordinates onto a tighter CURRENT scene.

        The original photo/crop provenance is retained. Refreshing the old scene
        can invalidate stale state, but a failed replacement never publishes a
        partial new scene or partially rebased component list. No model is called.
        """
        self.update(frame, context)
        if self.phase != 'ready' or not self.approved or not self.components:
            raise ValueError('The diagnostic map is no longer current enough to reanchor.')
        points = [self.scene.verify_point(item['x'], item['y']) for item in self.components]
        region = self.framing_region() if roi is None else dict(roi)
        replacement = RegisteredScene(frame, region)
        rebased = []
        for item, point in zip(self.components, points):
            x, y = point / [self.width - 1, self.height - 1]
            replacement.verify_point(float(x), float(y))
            rebased.append({**item, 'x': float(x), 'y': float(y)})
        self.scene, self.components, self.roi = replacement, rebased, region

    def tracker(self, component_id):
        self.component(component_id)
        return _DiagnosisPoint(self, component_id)

    def framing_region(self) -> dict:
        """Enclose all CURRENT projected targets and context in full-image units.

        At least 64 pixels per dimension, normally at most 90% of the view. A
        wider span is retained only when necessary to include every target.
        This region is not a claim that the entire circuit is visible.
        """
        if not self.components or self.phase != 'ready':
            raise ValueError('No currently located diagnostic targets are available for framing.')
        points = np.array([self.scene.resolve(item['x'], item['y']) for item in self.components])
        dimensions = np.array([self.width - 1, self.height - 1], dtype=float)
        return _region_for_points(points, dimensions)


def _region_for_points(points: np.ndarray, dimensions: np.ndarray) -> dict:
    low, high = points.min(axis=0), points.max(axis=0)
    span = high - low
    padding = np.maximum(32., np.maximum(0.06 * dimensions, 0.2 * span))
    # A sparse pin/header can be a good target but a poor plane reference by
    # itself. Include nearby PCB detail: 240px per side at a 1280px long edge,
    # scaling with resolution while keeping unusual aspect ratios local.
    context_size = max(65., min(240. * float(np.max(dimensions)) / 1279.,
                                0.4 * float(np.min(dimensions))))
    size = np.maximum(context_size, span + 2 * padding)
    cap = np.maximum(context_size, np.where(span > 0.9 * dimensions, dimensions, 0.9 * dimensions))
    size = np.minimum(dimensions, np.minimum(size, cap))
    centre = (low + high) / 2
    start = np.clip(centre - size / 2, 0, dimensions - size)
    result = np.r_[start / dimensions, size / dimensions]
    return {key: float(value) for key, value in zip(('x', 'y', 'width', 'height'), result)}


class _DiagnosisPoint:
    """Resolve by stable target ID, including across an atomic reference rebase."""
    def __init__(self, mapped, component_id):
        self.mapped, self.component_id = mapped, component_id

    def update(self, frame):
        component = self.mapped.component(self.component_id)
        self.mapped.scene.update(frame)
        return self.mapped.scene.verify_point(component['x'], component['y'])


def _blob_centres(binary: np.ndarray, board_area: float, *, holes: bool) -> tuple[np.ndarray, np.ndarray]:
    count, _, stats, centres = cv2.connectedComponentsWithStats(binary, connectivity=8)
    selected, areas = [], []
    for index in range(1, count):
        _, _, width, height, area = stats[index]
        if (3 <= area <= board_area * (0.004 if holes else 0.04) and width >= 2 and height >= 2
                and 0.45 <= width / height <= (2.2 if holes else 5)
                and area / (width * height) >= 0.4):
            selected.append(centres[index])
            areas.append(area)
    return np.asarray(selected, dtype=float).reshape(-1, 2), np.asarray(areas, dtype=float)


def _grid_like(points: np.ndarray, areas: np.ndarray, box: np.ndarray) -> bool:
    if not 12 <= len(points) <= 4096:
        return False
    basis = np.array([box[1] - box[0], box[3] - box[0]], dtype=float)
    lengths = np.linalg.norm(basis, axis=1)
    coordinates = (points - box[0]) @ (basis / lengths[:, None]).T
    tolerance = max(2.5, math.sqrt(float(np.median(areas))) * 0.65)
    for axis in range(2):
        groups = []
        for value in sorted(coordinates[:, axis]):
            if groups and value - np.mean(groups[-1]) <= tolerance:
                groups[-1].append(value)
            else:
                groups.append([value])
        supported = [group for group in groups if len(group) >= 3]
        if len(supported) < 3 or sum(map(len, supported)) < len(points) * 0.65:
            return False
        centres = np.array([np.mean(group) for group in supported])
        gaps = np.diff(centres)
        spacing = float(np.median(gaps))
        if (np.ptp(centres) < lengths[axis] * 0.3 or spacing <= tolerance
                or np.mean(np.abs(gaps - spacing) <= spacing * 0.35) < 0.7):
            return False
    return True


def find_circuit_region(image) -> dict | None:
    """Suggest one visible breadboard/green-or-blue-PCB-like area, or nothing.

    Color alone is insufficient: pale boards need a distributed regular hole
    pattern; colored boards need distributed high-contrast details and edges.
    A board may touch the image edge; only its visible portion is proposed.
    This local heuristic neither identifies components nor diagnoses a circuit.
    Ambiguous competing candidates return None. Processing is capped at 960px.
    """
    if (not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.ndim != 3
            or image.shape[2] != 3 or min(image.shape[:2]) < 64):
        return None
    height, width = image.shape[:2]
    factor = min(1., 960 / max(height, width))
    size = (round(width * factor), round(height * factor))
    small = cv2.resize(image, size, interpolation=cv2.INTER_AREA) if factor < 1 else image
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 140)
    masks = [('pale', cv2.inRange(hsv, (0, 0, 135), (179, 70, 255))),
             ('green', cv2.inRange(hsv, (33, 65, 35), (89, 255, 255))),
             ('blue', cv2.inRange(hsv, (90, 55, 20), (135, 255, 255)))]
    frame_area = size[0] * size[1]
    candidates = []
    for kind, raw_mask in masks:
        kernel = np.ones((5, 5) if kind == 'pale' else (7, 7), np.uint8)
        mask = cv2.morphologyEx(raw_mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
            area = cv2.contourArea(contour)
            if not (0.02 if kind == 'pale' else 0.008) * frame_area <= area <= 0.85 * frame_area:
                continue
            rectangle = cv2.minAreaRect(contour)
            sides = rectangle[1]
            if min(sides) < max(30, 64 * factor) or max(sides) / min(sides) > 7:
                continue
            rectangle_area = max(1., sides[0] * sides[1])
            if rectangle_area < 0.015 * frame_area:
                continue
            # Dark ICs and headers remove substantial color-mask area from a
            # genuine PCB. Its convex envelope must remain rectangular, with
            # substantial actual board color and independently checked details.
            colored_fraction = area / rectangle_area
            rectangularity = (area if kind == 'pale' else cv2.contourArea(cv2.convexHull(contour))) / rectangle_area
            if kind != 'pale' and colored_fraction < 0.4:
                continue
            if rectangularity < 0.8:
                continue
            box = cv2.boxPoints(rectangle)
            polygon = np.zeros(gray.shape, np.uint8)
            cv2.fillConvexPoly(polygon, np.rint(box).astype(np.int32), 255)
            inside = cv2.erode(polygon, np.ones((9, 9), np.uint8)) > 0
            if not np.any(inside):
                continue
            base_brightness = float(np.median(gray[inside]))
            dark_offset = 40 if kind == 'pale' else max(15, base_brightness * 0.3)
            light_offset = 45 if kind == 'pale' else max(25, base_brightness * 0.35)
            dark = np.where(inside & (gray < min(145, base_brightness - dark_offset)), 255, 0).astype(np.uint8)
            light = np.where(inside & (gray > base_brightness + light_offset), 255, 0).astype(np.uint8)
            dark_points, dark_areas = _blob_centres(dark, area, holes=kind == 'pale')
            edge_fraction = float(np.mean(edges[inside] > 0))
            if not (0.015 if kind == 'pale' else 0.007) <= edge_fraction <= 0.27:
                continue
            if kind == 'pale':
                if not _grid_like(dark_points, dark_areas, box):
                    continue
            else:
                light_points, _ = _blob_centres(light, area, holes=False)
                if len(dark_points) < 3 or len(light_points) < 3:
                    continue
                detail = np.vstack((dark_points, light_points))
                if cv2.contourArea(cv2.convexHull(detail.astype(np.float32))) < area * 0.15:
                    continue
            x, y, crop_width, crop_height = cv2.boundingRect(contour)
            padding = max(4, round(min(crop_width, crop_height) * 0.04))
            left, top = max(0, x - padding), max(0, y - padding)
            right, bottom = min(size[0] - 1, x + crop_width - 1 + padding), min(size[1] - 1, y + crop_height - 1 + padding)
            roi = {'x': left / (size[0] - 1), 'y': top / (size[1] - 1),
                   'width': (right - left) / (size[0] - 1), 'height': (bottom - top) / (size[1] - 1)}
            candidates.append((area * rectangularity, roi))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    if len(candidates) > 1 and candidates[1][0] >= candidates[0][0] * 0.75:
        return None
    return candidates[0][1]
