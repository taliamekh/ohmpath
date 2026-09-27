"""Synthetic diagnostic-map and area-discovery tests; no model or device calls."""
import base64
from copy import deepcopy
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from ohmpath.devices.turret_guidance import DiagnosisMap, diagnosis_prompt, find_circuit_region
from ohmpath.devices.turret_targets import ComponentIdentifier, ComponentMap, IDENTIFY_PROMPT
from ohmpath.devices.turret_scene import RegisteredScene


ROI = {'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8}
CONTEXT = ('camera-one', 'profile-one', 0)


class Lock:
    def __init__(self):
        self.depth = 0
    def __enter__(self):
        self.depth += 1
    def __exit__(self, *args):
        self.depth -= 1


class Photos:
    def __init__(self, admission):
        self.admission = admission
        self.calls = []
        self.cancelled = []
        self.answer = {'status': 'running'}
    def start(self, context, question, images):
        assert self.admission.depth == 1
        self.calls.append((context, question, deepcopy(images)))
        return {'turn_id': 'fake-turn'}
    def status(self, turn_id):
        assert turn_id == 'fake-turn'
        return deepcopy(self.answer)
    def cancel(self, context):
        self.cancelled.append(context)


def pixels(width=640, height=480):
    rng = np.random.default_rng(393)
    small = rng.integers(20, 235, (height // 4, width // 4, 3), dtype=np.uint8)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST)


def frame(image=None, sequence=1, generation='camera-one'):
    return {'image': pixels() if image is None else image, 'sequence': sequence, 'generation': generation}


def setup(image=None, roi=ROI):
    admission = Lock()
    investigations = SimpleNamespace(lock=Lock(), jobs={})
    photos = Photos(admission)
    identifier = ComponentIdentifier(photos, investigations, admission)
    reference = frame(image)
    mapped = DiagnosisMap(reference, roi, CONTEXT, identifier, 'Why does the LED not light?')
    return mapped, photos, reference, investigations


def complete(mapped, photos, annotations=None):
    if annotations is None:
        annotations = [
            {'image_id': mapped.image_id, 'x': 0.65, 'y': 0.6, 'label': 'Test: LED polarity'},
            {'image_id': mapped.image_id, 'x': 0.3, 'y': 0.4, 'label': 'Inspect: supply rail break'},
        ]
    photos.answer = {'status': 'completed', 'answer': {
        'explanation': 'The LED may be reversed; the photo cannot confirm the connection.',
        'next_steps': ['Check the marked LED orientation.', 'Check supply voltage with a meter.'],
        'limitations': ['No physical measurement is available.'], 'annotations': annotations,
    }}


def test_diagnosis_uses_same_admission_crop_and_question_without_component_inventory_prompt():
    mapped, photos, reference, _ = setup()
    context, prompt, images = photos.calls[0]
    assert context == mapped.map_id
    assert 'Why does the LED not light?' in prompt
    assert 'highest diagnostic priority' in prompt
    assert 'Do not make a general inventory' in prompt
    assert IDENTIFY_PROMPT not in prompt
    assert len(prompt) <= 4000
    assert len(images) == 1 and images[0]['image_id'] == mapped.image_id
    sent = base64.b64decode(images[0]['image_base64'])
    x0, y0, x1, y1 = mapped.crop
    okay, expected = cv2.imencode('.jpg', reference['image'][y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert okay and sent == expected.tobytes()
    assert mapped.phase == 'identifying' and not mapped.approved
    assert mapped.scene is None


def test_pending_diagnosis_ignores_moving_background_and_registers_only_returned_board_targets():
    mapped, photos, reference, _ = setup(roi={'x': 0., 'y': 0., 'width': 1., 'height': 1.})
    current = np.full_like(reference['image'], 195)
    # Only the circuit region survives; a person/background elsewhere changes.
    current[258:438, 62:412] = reference['image'][250:430, 50:400]
    mapped.update(frame(current, 2), CONTEXT)
    assert mapped.phase == 'identifying' and mapped.scene is None
    assert mapped.summary()['registration_reference_sequence'] is None
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': x, 'y': y, 'label': 'Test: board detail'}
                             for x, y in ((0.27, 0.65), (0.42, 0.73))])
    mapped.update(frame(current, 3), CONTEXT)
    assert mapped.phase == 'ready' and mapped.approved
    assert mapped.roi['width'] < 0.4 and mapped.roi['height'] < 0.3
    assert mapped.scene.reference_sequence == 1
    assert mapped.scene.sequence == 3
    for component, (x, y) in zip(mapped.components, ((0.27, 0.65), (0.42, 0.73))):
        np.testing.assert_allclose(mapped.scene.verify_point(component['x'], component['y']),
                                   [x * 639 + 12, y * 479 + 8], atol=2)
    assert len(photos.calls) == 1


def test_pending_diagnosis_does_not_accept_a_target_removed_since_the_submitted_image():
    mapped, photos, reference, _ = setup(roi={'x': 0., 'y': 0., 'width': 1., 'height': 1.})
    current = reference['image'].copy()
    current[285:340, 147:199] = 130
    mapped.update(frame(current, 2), CONTEXT)
    assert mapped.phase == 'identifying'
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': x, 'y': y, 'label': 'Test: board detail'}
                             for x, y in ((0.27, 0.65), (0.42, 0.73))])
    mapped.update(frame(current, 3), CONTEXT)
    assert mapped.phase == 'failed' and not mapped.approved
    assert mapped.scene is None
    assert mapped.summary()['answer']['explanation']


def test_single_sparse_header_uses_nearby_pcb_texture_through_motion_and_still_checks_target():
    image = np.full((1280, 720, 3), 165, np.uint8)
    cx, cy = 340, 840
    image[cy - 130:cy + 130, cx - 130:cx + 130] = (70, 42, 20)
    rng = np.random.default_rng(534)
    for dx, dy in ((-88, -88), (88, -88), (-88, 88), (88, 88), (-88, 0), (88, 0)):
        detail = cv2.resize(rng.integers(20, 235, (10, 10, 3), np.uint8), (40, 40),
                            interpolation=cv2.INTER_NEAREST)
        image[cy + dy - 20:cy + dy + 20, cx + dx - 20:cx + dx + 20] = detail
    for dy in range(-28, 29, 7):
        for dx in (-5, 5):
            cv2.rectangle(image, (cx + dx - 1, cy + dy - 2), (cx + dx + 1, cy + dy + 2), (215, 215, 215), -1)
    point = (cx / 719, cy / 1279)
    narrow = {'x': point[0] - 0.06, 'y': point[1] - 0.06, 'width': 0.12, 'height': 0.12}
    with pytest.raises(ValueError, match='clustered|few distinctive'):
        RegisteredScene(frame(image), narrow)
    mapped, photos, reference, _ = setup(image, roi={'x': 0., 'y': 0., 'width': 1., 'height': 1.})
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': point[0], 'y': point[1], 'label': 'Test: header contact'}])
    mapped.update(reference, CONTEXT)
    assert mapped.phase == 'ready'
    assert mapped.roi['width'] * 719 == pytest.approx(240)
    assert mapped.roi['height'] * 1279 == pytest.approx(240)
    tracker = mapped.tracker(mapped.components[0]['id'])
    shifted = cv2.warpAffine(image, np.float32([[1, 0, 16], [0, 1, -8]]), (720, 1280))
    np.testing.assert_allclose(tracker.update(frame(shifted, 2)), [cx + 16, cy - 8], atol=2)
    removed = shifted.copy()
    removed[cy - 8 - 32:cy - 8 + 32, cx + 16 - 20:cx + 16 + 20] = (70, 42, 20)
    with pytest.raises(ValueError, match='texture|appearance'):
        tracker.update(frame(removed, 3))


@pytest.mark.parametrize('size,minimum', [((720, 1280), 240), ((1280, 720), 240), ((640, 480), 240 * 639 / 1279)])
def test_single_target_registration_context_scales_consistently_with_resolution(size, minimum):
    mapped, photos, reference, _ = setup(pixels(*size))
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': 0.5, 'y': 0.5, 'label': 'Test: centre detail'}])
    mapped.update(reference, CONTEXT)
    assert mapped.phase == 'ready'
    assert mapped.roi['width'] * (size[0] - 1) == pytest.approx(minimum)
    assert mapped.roi['height'] * (size[1] - 1) == pytest.approx(minimum)


@pytest.mark.parametrize('change', ['context', 'generation', 'geometry', 'sequence'])
def test_pending_diagnosis_checks_identity_without_registering_background(change):
    mapped, photos, reference, _ = setup()
    current = dict(reference)
    context = CONTEXT
    if change == 'context':
        context = ('camera-one', 'different-profile', 0)
    elif change == 'generation':
        current['generation'] = 'replacement-camera'
    elif change == 'geometry':
        current['image'] = cv2.resize(reference['image'], (720, 480))
    else:
        current['sequence'] = 0
    mapped.update(current, context)
    assert mapped.phase == 'lost' and mapped.scene is None
    assert photos.cancelled == [mapped.map_id]


def test_diagnosis_cannot_bypass_active_investigation():
    mapped, photos, _, investigations = setup()
    investigations.jobs['active'] = {'worker': SimpleNamespace(is_alive=lambda: True)}
    with pytest.raises(ValueError, match='current circuit investigation'):
        mapped.identifier.start_diagnosis('other-context', 'other-image', b'not sent', 'What is wrong?')
    assert len(photos.calls) == 1


def test_diagnostic_targets_keep_priority_order_and_become_ready_without_another_review():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    summary = mapped.summary()
    assert summary['phase'] == 'ready' and summary['approved']
    assert [item['label'] for item in summary['components']] == ['Test: LED polarity', 'Inspect: supply rail break']
    assert [item['number'] for item in summary['components']] == [1, 2]
    assert summary['explanation'] == photos.answer['answer']['explanation']
    assert summary['next_steps'] == photos.answer['answer']['next_steps']
    assert summary['limitations'] == photos.answer['answer']['limitations']
    assert summary['evidence_kind'] == 'visual_diagnosis_candidates'
    assert summary['kind'] == 'diagnosis'
    assert summary['answer'] == {key: photos.answer['answer'][key] for key in ('explanation', 'next_steps', 'limitations')}
    assert np.isfinite(mapped.tracker(mapped.components[0]['id']).update(reference)).all()
    summary['next_steps'].append('changed by a caller')
    assert len(mapped.summary()['next_steps']) == 2


def test_empty_annotations_preserve_answer_without_inventing_a_target_or_requiring_review():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos, [])
    mapped.update(reference, CONTEXT)
    summary = mapped.summary()
    assert summary['phase'] == 'no_targets' and not summary['approved']
    assert summary['components'] == []
    assert summary['explanation'] and summary['next_steps'] and summary['limitations']
    with pytest.raises(ValueError):
        mapped.tracker('imagined target')
    with pytest.raises(ValueError, match='No currently located'):
        mapped.framing_region()


def test_flat_target_fails_local_validation_but_retains_diagnostic_answer():
    image = pixels()
    image[195:285, 275:365] = 130
    mapped, photos, reference, _ = setup(image)
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': 0.5, 'y': 0.5, 'label': 'Inspect: flat location'}])
    mapped.update(reference, CONTEXT)
    summary = mapped.summary()
    assert summary['phase'] == 'failed' and not summary['approved']
    assert summary['explanation'] and summary['limitations']
    assert 'could not be located reliably' in summary['message']


def test_stale_annotation_retains_explanation_while_cancelling_target_map():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos, [{'image_id': 'old-image', 'x': 0.5, 'y': 0.5, 'label': 'Test: old location'}])
    mapped.update(reference, CONTEXT)
    summary = mapped.summary()
    assert summary['phase'] == 'lost' and not summary['approved']
    assert summary['explanation'] and summary['limitations']
    assert photos.cancelled == [mapped.map_id]


def test_reference_change_revokes_diagnosis_and_preserves_answer_for_display():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    mapped.update(frame(reference['image'], 2, generation='replacement'), CONTEXT)
    assert mapped.summary()['phase'] == 'lost'
    assert mapped.summary()['explanation']
    with pytest.raises(ValueError):
        mapped.framing_region()


def test_reanchor_tightens_full_frame_reference_and_preserves_shifted_target_and_source_provenance():
    whole = {'x': 0., 'y': 0., 'width': 1., 'height': 1.}
    mapped, photos, reference, _ = setup(roi=whole)
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    originals = deepcopy(mapped.components)
    source_crop, source_image, source_sequence = mapped.crop, mapped.image_id, mapped.source_sequence
    tracker = mapped.tracker(originals[0]['id'])
    shifted = cv2.warpAffine(reference['image'], np.float32([[1, 0, 18], [0, 1, -12]]), (640, 480))
    current = frame(shifted, 2)
    mapped.reanchor(current, CONTEXT)
    assert mapped.scene.reference_sequence == 2
    assert mapped.roi['width'] < 1 and mapped.roi['height'] < 1
    assert mapped.source_roi == whole
    assert (mapped.crop, mapped.image_id, mapped.source_sequence) == (source_crop, source_image, source_sequence)
    assert len(photos.calls) == 1
    assert mapped.summary()['registration_reference_sequence'] == 2
    assert mapped.summary()['source_sequence'] == 1
    for original, component in zip(originals, mapped.components):
        assert (component['id'], component['label']) == (original['id'], original['label'])
        expected = np.array([original['x'] * 639 + 18, original['y'] * 479 - 12])
        np.testing.assert_allclose([component['x'] * 639, component['y'] * 479], expected, atol=2)
    # Even a tracker obtained before reanchoring resolves the stable ID afresh.
    expected = np.array([originals[0]['x'] * 639 + 18, originals[0]['y'] * 479 - 12])
    np.testing.assert_allclose(tracker.update(current), expected, atol=2)
    later = frame(cv2.warpAffine(shifted, np.float32([[1, 0, 12], [0, 1, 8]]), (640, 480)), 3)
    np.testing.assert_allclose(tracker.update(later), expected + [12, 8], atol=2)


@pytest.mark.parametrize('bad_roi', [
    {'x': -0.1, 'y': 0.1, 'width': 0.4, 'height': 0.4},
    {'x': 0.65, 'y': 0.4, 'width': 0.25, 'height': 0.3},
])
def test_failed_reanchor_does_not_partially_replace_scene_points_or_region(bad_roi):
    mapped, photos, reference, _ = setup()
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    previous_scene = mapped.scene
    previous_points, previous_roi = deepcopy(mapped.components), dict(mapped.roi)
    with pytest.raises(ValueError):
        mapped.reanchor(reference, CONTEXT, bad_roi)
    assert mapped.scene is previous_scene
    assert mapped.components == previous_points and mapped.roi == previous_roi
    assert mapped.phase == 'ready' and mapped.approved
    assert len(photos.calls) == 1


def test_reanchor_cannot_make_a_removed_target_the_new_reference():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    previous_scene, previous_points = mapped.scene, deepcopy(mapped.components)
    altered = reference['image'].copy()
    target = mapped.components[0]
    x, y = round(target['x'] * 639), round(target['y'] * 479)
    altered[y - 38:y + 38, x - 38:x + 38] = 128
    with pytest.raises(ValueError, match='texture|appearance'):
        mapped.reanchor(frame(altered, 2), CONTEXT)
    assert mapped.scene is previous_scene and mapped.components == previous_points


def test_reanchor_rejects_changed_context_and_does_not_revive_a_lost_map():
    mapped, photos, reference, _ = setup()
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    previous_scene = mapped.scene
    with pytest.raises(ValueError, match='no longer current'):
        mapped.reanchor(reference, ('camera-one', 'different-profile', 0))
    assert mapped.scene is previous_scene
    assert mapped.phase == 'lost' and not mapped.approved


@pytest.mark.parametrize('size', [(640, 480), (720, 1280)])
def test_framing_region_encloses_current_projected_targets_with_context(size):
    mapped, photos, reference, _ = setup(pixels(*size))
    complete(mapped, photos)
    mapped.update(reference, CONTEXT)
    before = mapped.framing_region()
    shifted = cv2.warpAffine(reference['image'], np.float32([[1, 0, 19], [0, 1, -12]]), size)
    mapped.update(frame(shifted, 2), CONTEXT)
    region = mapped.framing_region()
    assert region['x'] == pytest.approx(before['x'] + 19 / (size[0] - 1), abs=2 / (size[0] - 1))
    assert region['y'] == pytest.approx(before['y'] - 12 / (size[1] - 1), abs=2 / (size[1] - 1))
    assert region['width'] * (size[0] - 1) >= 64
    assert region['height'] * (size[1] - 1) >= 64
    assert region['width'] <= 0.9 and region['height'] <= 0.9
    for component in mapped.components:
        point = mapped.scene.resolve(component['x'], component['y']) / [size[0] - 1, size[1] - 1]
        assert region['x'] <= point[0] <= region['x'] + region['width']
        assert region['y'] <= point[1] <= region['y'] + region['height']


def test_single_target_near_edge_still_has_64_pixel_context_inside_view():
    mapped, photos, reference, _ = setup(roi={'x': 0., 'y': 0., 'width': 1., 'height': 1.})
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': 0.02, 'y': 0.03, 'label': 'Inspect: edge detail'}])
    mapped.update(reference, CONTEXT)
    assert mapped.phase == 'ready'
    region = mapped.framing_region()
    assert region['x'] >= 0 and region['y'] >= 0
    assert region['x'] + region['width'] <= 1
    assert region['y'] + region['height'] <= 1
    assert region['width'] * 639 >= 64 and region['height'] * 479 >= 64
    assert region['x'] <= 0.02 <= region['x'] + region['width']
    assert region['y'] <= 0.03 <= region['y'] + region['height']


def test_widely_spaced_targets_are_not_cropped_to_force_90_percent_limit():
    mapped, photos, reference, _ = setup(roi={'x': 0., 'y': 0., 'width': 1., 'height': 1.})
    complete(mapped, photos, [{'image_id': mapped.image_id, 'x': x, 'y': 0.5, 'label': f'Test: {x}'}
                             for x in (0.03, 0.97)])
    mapped.update(reference, CONTEXT)
    region = mapped.framing_region()
    assert region['width'] >= 0.94
    assert region['x'] <= 0.03 and region['x'] + region['width'] >= 0.97


def test_original_component_map_still_uses_inventory_and_explicit_review():
    diagnosis, photos, reference, _ = setup()
    inventory = ComponentMap(reference, ROI, CONTEXT, diagnosis.identifier)
    assert photos.calls[-1][1] == IDENTIFY_PROMPT
    complete(inventory, photos)
    inventory.update(reference, CONTEXT)
    assert inventory.phase == 'review' and not inventory.approved


@pytest.mark.parametrize('question', ['', '   ', None, True, 'x' * 4001])
def test_invalid_question_is_rejected_before_submission(question):
    with pytest.raises(ValueError, match='question'):
        diagnosis_prompt(question)


def test_full_question_limit_preserves_original_and_budgets_photo_prompt_explicitly():
    original = 'Beginning:' + 'x' * 3976 + ':Important end'
    assert len(original) <= 4000
    prompt = diagnosis_prompt(original)
    assert len(prompt) <= 4000
    assert 'Beginning:' in prompt and ':Important end' in prompt
    assert 'Question shortened' in prompt
    admission = Lock()
    photos = Photos(admission)
    identifier = ComponentIdentifier(photos, SimpleNamespace(lock=Lock(), jobs={}), admission)
    mapped = DiagnosisMap(frame(), ROI, CONTEXT, identifier, original)
    assert mapped.summary()['question'] == original
    assert mapped.summary()['question_truncated_for_model']


def breadboard(width=640, height=480, *, detailed=True, tiny=False):
    image = np.full((height, width, 3), (55, 75, 100), np.uint8)
    if tiny:
        left, top, right, bottom = 280, 200, 322, 234
    else:
        left, top, right, bottom = round(width * 0.2), round(height * 0.22), round(width * 0.8), round(height * 0.78)
    cv2.rectangle(image, (left, top), (right, bottom), (220, 224, 225), -1)
    if detailed:
        for y in range(top + 13, bottom - 10, 16):
            for x in range(left + 13, right - 10, 16):
                cv2.circle(image, (x, y), 2, (55, 55, 55), -1)
    return image


def pcb(*, detailed=True):
    image = np.full((480, 640, 3), (55, 75, 100), np.uint8)
    cv2.rectangle(image, (145, 115), (495, 365), (45, 125, 50), -1)
    if detailed:
        for y in (155, 225, 305):
            for x in (185, 285, 405):
                cv2.rectangle(image, (x, y), (x + 22, y + 17), (20, 20, 20), -1)
                cv2.rectangle(image, (x + 28, y), (x + 35, y + 6), (220, 220, 205), -1)
    return image


@pytest.mark.parametrize('size', [(640, 480), (720, 1280)])
def test_detects_breadboard_like_rectangle_with_regular_holes_in_landscape_and_portrait(size):
    region = find_circuit_region(breadboard(*size))
    assert region is not None
    assert region['x'] <= 0.2 and region['x'] + region['width'] >= 0.8
    assert region['y'] <= 0.22 and region['y'] + region['height'] >= 0.78
    assert 0 <= region['x'] < 1 and 0 <= region['y'] < 1
    assert region['x'] + region['width'] <= 1 and region['y'] + region['height'] <= 1


def test_detects_green_pcb_like_rectangle_only_with_distributed_component_details():
    region = find_circuit_region(pcb())
    assert region is not None
    assert region['x'] <= 145 / 639 and region['x'] + region['width'] >= 495 / 639
    assert find_circuit_region(pcb(detailed=False)) is None


def blue_pcb(*, clipped=False, detailed=True):
    image = np.full((1280, 720, 3), 165, np.uint8)
    # Dark navy surface with large black headers/chips; color occupancy alone
    # should not require an almost-solid colored rectangle.
    left, top, right, bottom = (0, 450, 132, 660) if clipped else (230, 450, 390, 660)
    cv2.rectangle(image, (left, top), (right, bottom), (75, 40, 15), -1)
    if detailed:
        for y in (475, 535, 595):
            for x in (left + 12, left + 60, left + 104):
                cv2.rectangle(image, (x, y), (min(x + 23, right - 3), y + 31), (12, 12, 12), -1)
                cv2.rectangle(image, (x, y + 36), (min(x + 10, right - 3), y + 41), (185, 185, 170), -1)
    return image, (left, top, right, bottom)


@pytest.mark.parametrize('clipped', [False, True])
def test_detects_dark_blue_pcb_with_components_even_when_clipped_at_image_edge(clipped):
    image, (left, top, right, bottom) = blue_pcb(clipped=clipped)
    region = find_circuit_region(image)
    assert region is not None
    assert region['x'] <= left / 719
    assert region['y'] <= top / 1279
    assert region['x'] + region['width'] >= right / 719
    assert region['y'] + region['height'] >= bottom / 1279
    if clipped:
        assert region['x'] == 0
    assert find_circuit_region(blue_pcb(clipped=clipped, detailed=False)[0]) is None


def test_blue_random_texture_and_plain_blue_objects_are_not_circuit_candidates():
    for seed in range(3):
        rng = np.random.default_rng(seed)
        image = np.full((480, 640, 3), 160, np.uint8)
        image[100:350, 150:500] = rng.integers(0, 255, (250, 350, 3), np.uint8)
        assert find_circuit_region(image) is None


@pytest.mark.parametrize('image', [
    np.zeros((480, 640, 3), np.uint8),
    np.full((480, 640, 3), 220, np.uint8),
    np.random.default_rng(9).integers(0, 256, (480, 640, 3), np.uint8),
    pixels(), breadboard(detailed=False), breadboard(tiny=True),
])
def test_detector_rejects_blank_random_texture_plain_rectangles_and_tiny_candidates(image):
    assert find_circuit_region(image) is None


def test_detector_rejects_two_equally_plausible_separate_boards():
    image = np.full((480, 900, 3), (55, 75, 100), np.uint8)
    source = breadboard()[106:375, 128:513]
    image[100:369, 20:405] = source
    image[100:369, 495:880] = source
    assert find_circuit_region(image) is None


@pytest.mark.parametrize('image', [None, np.zeros((20, 20, 3), np.uint8),
                                  np.zeros((200, 200), np.uint8), np.zeros((200, 200, 3), float)])
def test_detector_invalid_input_has_no_candidate(image):
    assert find_circuit_region(image) is None
