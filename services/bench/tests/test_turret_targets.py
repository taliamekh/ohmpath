"""Local component-map and HD tracking tests; no model, camera or motor access."""
import base64
from copy import deepcopy
import os
import subprocess
from types import SimpleNamespace
import uuid

import cv2
import numpy as np
import pytest

from ohmpath.devices.turret_targets import ComponentIdentifier, ComponentMap, IDENTIFY_PROMPT
from ohmpath.devices.turret_vision import PointTracker
from ohmpath.vision.tracking import MAX_HEIGHT, MAX_IMAGE_BYTES, MAX_WIDTH


ROI = {'x': 0.15, 'y': 0.15, 'width': 0.7, 'height': 0.7}
CONTEXT = {'camera': 'camera-one', 'rotation': 0, 'profile_revision': 'profile-one'}


class RecordingLock:
    def __init__(self):
        self.depth = 0
        self.entries = 0

    def __enter__(self):
        self.depth += 1
        self.entries += 1
        return self

    def __exit__(self, *args):
        self.depth -= 1


class FakePhotoHelp:
    def __init__(self, admission):
        self.admission = admission
        self.starts = []
        self.cancelled = []
        self.polls = []
        self.results = {}

    def start(self, context, question, images):
        assert self.admission.depth == 1
        turn_id = str(uuid.uuid4())
        self.starts.append({'context': context, 'question': question, 'images': deepcopy(images), 'turn_id': turn_id})
        self.results[turn_id] = {'turn_id': turn_id, 'status': 'running'}
        return deepcopy(self.results[turn_id])

    def status(self, turn_id):
        self.polls.append(turn_id)
        return deepcopy(self.results[turn_id])

    def cancel(self, context):
        self.cancelled.append(context)
        return {'status': 'cancelled', 'context_id': context}

    def complete(self, component_map, annotations=None, **answer):
        if annotations is None:
            annotations = [annotation(component_map)]
        self.results[component_map.turn_id] = {
            'turn_id': component_map.turn_id, 'status': 'completed',
            'answer': {'annotations': annotations, 'explanation': 'Synthetic visual candidates.', **answer},
        }


def stack():
    admission = RecordingLock()
    investigations = SimpleNamespace(lock=RecordingLock(), jobs={})
    photo = FakePhotoHelp(admission)
    return ComponentIdentifier(photo, investigations, admission), photo, investigations, admission


def image(width=640, height=480, seed=120):
    rng = np.random.default_rng(seed)
    # Distinctive, distributed texture with more than one pixel per feature.
    small = rng.integers(20, 235, (height // 4, width // 4, 3), dtype=np.uint8)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST)


def frame(pixels=None, sequence=10, generation='camera-one'):
    return {'image': image() if pixels is None else pixels, 'sequence': sequence, 'generation': generation}


def annotation(component_map, **values):
    return {'image_id': component_map.image_id, 'label': 'R1 resistor body', 'x': 0.5, 'y': 0.5, **values}


def reviewing(pixels=None):
    identifier, photo, investigations, admission = stack()
    reference = frame(pixels)
    component_map = ComponentMap(reference, ROI, deepcopy(CONTEXT), identifier)
    photo.complete(component_map)
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'review'
    return component_map, photo, reference


def test_identifier_uses_existing_admission_and_sends_only_frozen_selected_crop():
    identifier, photo, investigations, admission = stack()
    reference = frame()
    # Outside the selected region, a private-looking colored border must not be sent.
    reference['image'][:40] = (240, 0, 240)
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    start = photo.starts[0]
    assert start['context'] == component_map.map_id
    assert start['question'] == IDENTIFY_PROMPT
    assert len(start['images']) == 1
    sent = start['images'][0]
    assert set(sent) == {'image_id', 'mime_type', 'image_base64'}
    assert sent['mime_type'] == 'image/jpeg'
    assert sent['image_id'] == component_map.image_id
    raw = base64.b64decode(sent['image_base64'])
    decoded = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    x0, y0, x1, y1 = component_map.crop
    assert decoded.shape[:2] == (y1 - y0, x1 - x0)
    assert decoded.shape[0] < reference['image'].shape[0]
    assert decoded.shape[1] < reference['image'].shape[1]
    success, expected = cv2.imencode('.jpg', reference['image'][y0:y1, x0:x1],
                                    [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert success and raw == expected.tobytes()
    assert admission.entries == investigations.lock.entries == 1
    assert admission.depth == investigations.lock.depth == 0
    assert component_map.summary()['evidence_kind'] == 'visual_candidates'
    assert component_map.approved is False


def test_busy_circuit_investigation_blocks_identification_before_media_submission():
    identifier, photo, investigations, admission = stack()
    investigations.jobs['active'] = {'worker': SimpleNamespace(is_alive=lambda: True)}
    with pytest.raises(ValueError, match='current circuit investigation'):
        identifier.start(str(uuid.uuid4()), str(uuid.uuid4()), b'no image should be sent')
    assert photo.starts == []
    assert admission.depth == investigations.lock.depth == 0
    assert admission.entries == investigations.lock.entries == 1


def test_crop_boundary_annotations_stay_inside_selected_region():
    identifier, photo, _, _ = stack()
    reference = frame()
    roi = {'x': .12, 'y': .12, 'width': .74, 'height': .74}
    component_map = ComponentMap(reference, roi, CONTEXT, identifier)
    photo.complete(component_map, [annotation(component_map, x=x, y=y)
                                  for x, y in [(0, 0), (0, 1), (1, 0), (1, 1)]])
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'review'
    for component in component_map.components:
        assert roi['x'] <= component['x'] <= roi['x'] + roi['width']
        assert roi['y'] <= component['y'] <= roi['y'] + roi['height']


def test_finished_investigation_does_not_block_new_identification_and_status_delegates():
    identifier, photo, investigations, _ = stack()
    investigations.jobs['finished'] = {'worker': SimpleNamespace(is_alive=lambda: False)}
    component_map = ComponentMap(frame(), ROI, CONTEXT, identifier)
    result = identifier.status(component_map.turn_id)
    assert result['status'] == 'running'
    assert photo.polls == [component_map.turn_id]


@pytest.mark.parametrize('size', [(640, 480), (720, 1280)])
def test_crop_annotations_map_to_original_image_and_require_explicit_current_approval(size):
    width, height = size
    identifier, photo, _, _ = stack()
    reference = frame(image(width, height))
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    with pytest.raises(ValueError, match='accept a current'):
        component_map.tracker('anything')
    photo.complete(component_map, [annotation(component_map, x=0.31, y=0.62)])
    component_map.update(reference, CONTEXT)
    selected = component_map.components[0]
    x0, y0, x1, y1 = component_map.crop
    expected = np.array([x0 + 0.31 * (x1 - x0 - 1), y0 + 0.62 * (y1 - y0 - 1)])
    np.testing.assert_allclose([selected['x'] * (width - 1), selected['y'] * (height - 1)], expected)
    with pytest.raises(ValueError, match='accept a current'):
        component_map.component(selected['id'])
    with pytest.raises(ValueError, match='no longer ready'):
        component_map.approve(str(uuid.uuid4()), reference, CONTEXT)
    assert component_map.approved is False
    component_map.approve(component_map.map_id, reference, CONTEXT)
    assert component_map.phase == 'ready' and component_map.approved
    np.testing.assert_allclose(component_map.tracker(selected['id']).update(reference), expected, atol=1e-6)
    assert component_map.summary()['evidence_kind'] == 'visual_candidates_accepted_by_user'
    with pytest.raises(ValueError, match='absent'):
        component_map.component(str(uuid.uuid4()))


@pytest.mark.parametrize('changes', [
    {'x': -0.01}, {'y': 1.01}, {'x': float('nan')}, {'y': float('inf')}, {'x': True},
    {'y': '0.5'}, {'image_id': 'old-snapshot'},
])
def test_out_of_bounds_or_stale_model_annotation_cannot_form_approved_map(changes):
    identifier, photo, _, _ = stack()
    reference = frame()
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    photo.complete(component_map, [annotation(component_map, **changes)])
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'lost'
    assert not component_map.approved
    assert photo.cancelled == [component_map.map_id]
    with pytest.raises(ValueError):
        component_map.approve(component_map.map_id, reference, CONTEXT)


@pytest.mark.parametrize('change', ['sequence', 'generation', 'context', 'size'])
def test_stale_camera_or_configuration_prevents_approval_and_cancels_old_identification(change):
    component_map, photo, reference = reviewing()
    candidate = dict(reference)
    context = deepcopy(CONTEXT)
    if change == 'sequence':
        candidate['sequence'] = 9
    elif change == 'generation':
        candidate['generation'] = 'replacement-camera'
    elif change == 'context':
        context['profile_revision'] = 'new-travel-settings'
    else:
        candidate['image'] = cv2.resize(candidate['image'], (720, 480))
    with pytest.raises(ValueError):
        component_map.approve(component_map.map_id, candidate, context)
    assert not component_map.approved
    assert component_map.phase == 'lost'
    assert photo.cancelled[-1] == component_map.map_id
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'lost'


def test_registered_board_translation_preserves_component_coordinates_for_local_tracker():
    component_map, _, reference = reviewing()
    component_map.approve(component_map.map_id, reference, CONTEXT)
    selected = component_map.components[0]
    tracker = component_map.tracker(selected['id'])
    matrix = np.float32([[1, 0, 16], [0, 1, -12]])
    shifted = frame(cv2.warpAffine(reference['image'], matrix, (640, 480)), 11)
    expected = np.array([selected['x'] * 639 + 16, selected['y'] * 479 - 12])
    np.testing.assert_allclose(tracker.update(shifted), expected, atol=2)
    marker = component_map.summary()['components'][0]['point']
    np.testing.assert_allclose([marker['x'] * 639, marker['y'] * 479], expected, atol=2)


@pytest.mark.parametrize('approved', [False, True])
@pytest.mark.parametrize('change', ['removed', 'moved', 'occluded'])
def test_component_change_is_rejected_even_when_same_board_still_registers(approved, change):
    component_map, _, reference = reviewing()
    selected = component_map.components[0]
    if approved:
        component_map.approve(component_map.map_id, reference, CONTEXT)
    altered = reference['image'].copy()
    old = altered[204:276, 284:356].copy()
    altered[204:276, 284:356] = 125
    if change == 'moved':
        altered[290:362, 375:447] = old
    elif change == 'occluded':
        altered[204:276, 284:356] = image(72, 72, seed=908)
    current = frame(altered, 11)
    if approved:
        with pytest.raises(ValueError, match='texture|appearance'):
            component_map.tracker(selected['id']).update(current)
    else:
        with pytest.raises(ValueError, match='texture|appearance'):
            component_map.approve(component_map.map_id, current, CONTEXT)
        assert not component_map.approved
    # The point projection alone is insufficient; appearance caused the refusal.
    assert component_map.scene.summary()['state'] == 'registered'


def test_closed_map_cancels_only_its_own_model_context_and_ignores_late_result():
    identifier, photo, _, _ = stack()
    reference = frame()
    old = ComponentMap(reference, ROI, CONTEXT, identifier)
    new = ComponentMap(reference, ROI, CONTEXT, identifier)
    old.close()
    assert photo.cancelled == [old.map_id]
    assert new.map_id not in photo.cancelled
    photo.complete(old)
    photo.complete(new)
    old.update(reference, CONTEXT)
    new.update(reference, CONTEXT)
    assert old.phase == 'cancelled' and not old.approved and old.components == []
    assert new.phase == 'review' and not new.approved
    assert photo.polls == [new.turn_id]


def test_existing_component_tracker_cannot_act_after_map_closed():
    component_map, _, reference = reviewing()
    component_map.approve(component_map.map_id, reference, CONTEXT)
    tracker = component_map.tracker(component_map.components[0]['id'])
    component_map.close()
    with pytest.raises(ValueError, match='no longer approved'):
        tracker.update(reference)


@pytest.mark.parametrize('status', ['failed', 'cancelled', 'stale'])
def test_nonrunning_identification_failure_stays_unapproved(status):
    identifier, photo, _, _ = stack()
    reference = frame()
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    photo.results[component_map.turn_id] = {'status': status, 'message': 'Synthetic refusal.'}
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'failed' and not component_map.approved
    assert component_map.message == 'Synthetic refusal.'


def test_empty_identification_does_not_create_ready_component_map():
    identifier, photo, _, _ = stack()
    reference = frame()
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    photo.complete(component_map, [])
    component_map.update(reference, CONTEXT)
    assert component_map.phase == 'failed'
    assert component_map.components == [] and not component_map.approved


def test_model_labels_and_extra_answer_fields_remain_data_never_device_or_shell_commands(monkeypatch):
    attempted = []

    def forbidden(*args, **kwargs):
        attempted.append(args)
        raise AssertionError('Component identification must not execute commands.')

    monkeypatch.setattr(os, 'system', forbidden)
    monkeypatch.setattr(subprocess, 'Popen', forbidden)
    identifier, photo, _, _ = stack()
    reference = frame()
    component_map = ComponentMap(reference, ROI, CONTEXT, identifier)
    label = "__import__('os').system('untrusted model text')"
    photo.complete(component_map, [annotation(component_map, label=label)],
                   servo_targets={'yaw': 2000, 'pitch': 2000}, command={'op': 'arm'})
    component_map.update(reference, CONTEXT)
    assert component_map.components[0]['label'] == label
    assert set(component_map.components[0]) == {'id', 'label', 'x', 'y'}
    assert component_map.phase == 'review' and not component_map.approved
    with pytest.raises(ValueError, match='accept a current'):
        component_map.tracker(component_map.components[0]['id'])
    assert attempted == []


def test_portrait_hd_point_tracker_stays_inside_decoder_limits_and_returns_original_pixels(monkeypatch):
    pixels = image(720, 1280)
    tracker = PointTracker()
    actual_process = tracker.tracker.process
    encoded = []

    def record(**kwargs):
        decoded = cv2.imdecode(np.frombuffer(kwargs['image'], np.uint8), cv2.IMREAD_COLOR)
        encoded.append((decoded.shape, len(kwargs['image'])))
        return actual_process(**kwargs)

    monkeypatch.setattr(tracker.tracker, 'process', record)
    first = tracker.update(frame(pixels), selected=(0.5, 0.5))
    np.testing.assert_allclose(first, [359.5, 639.5], atol=1.1)
    shifted = cv2.warpAffine(pixels, np.float32([[1, 0, 12], [0, 1, -8]]), (720, 1280))
    second_frame = frame(shifted, 11)
    point = tracker.update(second_frame)
    np.testing.assert_allclose(point, first + [12, -8], atol=1.1)
    np.testing.assert_allclose(tracker.update(second_frame), point)
    assert len(encoded) == 2
    for shape, byte_count in encoded:
        assert shape == (640, 360, 3)
        assert shape[0] <= MAX_HEIGHT and shape[1] <= MAX_WIDTH
        assert byte_count <= MAX_IMAGE_BYTES
