import cv2
import numpy as np
import pytest

from ohmpath.devices.turret_spot import detect_red_spot


def frame(width=1280, height=720):
    return np.full((height, width, 3), 55, dtype=np.uint8)


def spot(image, point, radius=9, white_core=True):
    cv2.circle(image, point, radius, (55, 65, 235), -1)
    cv2.circle(image, point, max(2, radius // 2), (150, 155, 255), -1)
    if white_core:
        cv2.circle(image, point, max(1, radius // 3), (250, 250, 255), -1)


@pytest.mark.parametrize('white_core', [True, False])
def test_off_center_white_or_pink_core_inside_red_halo(white_core):
    image = frame()
    before = image.copy()
    spot(image, (870, 455), white_core=white_core)
    before[:] = image
    result = detect_red_spot(image)
    assert result['x'] == pytest.approx(870 / 1279, abs=1 / 1279)
    assert result['y'] == pytest.approx(455 / 719, abs=1 / 719)
    assert 6 < result['radius_px'] < 11
    assert result['candidate_count'] == 1
    assert result['source'] == 'red_spot_candidate'
    assert result['physically_verified'] is False
    np.testing.assert_array_equal(image, before)


def test_red_led_distractor_is_ambiguous_without_user_selection():
    image = frame()
    spot(image, (350, 200))
    cv2.circle(image, (800, 460), 7, (10, 20, 250), -1)
    with pytest.raises(ValueError, match='Multiple plausible'):
        detect_red_spot(image)


def test_exposed_pink_halo_with_white_core_seen_by_pi_camera():
    image = np.full((1280,720,3), 140, dtype=np.uint8)
    cv2.ellipse(image, (362,732), (19,16), 0, 0, 360, (182,163,221), -1)
    cv2.circle(image, (362,732), 6, (237,236,232), -1)
    image = cv2.GaussianBlur(image, (5,5), .8)
    result = detect_red_spot(image)
    assert result['x']*719 == pytest.approx(362, abs=1.5)
    assert result['y']*1279 == pytest.approx(732, abs=1.5)
    assert result['physically_verified'] is False


def test_pale_pink_object_without_bright_core_is_not_selected():
    image = frame()
    cv2.circle(image,(500,400),10,(182,163,221),-1)
    with pytest.raises(ValueError,match='No clear compact'):
        detect_red_spot(image)


def test_tiny_bright_pink_spot_on_blue_board_survives_portrait_processing():
    image = np.full((1280, 720, 3), (90, 45, 25), dtype=np.uint8)
    cv2.ellipse(image, (363, 723), (1, 2), 0, 0, 360, (210, 190, 230), -1)
    image[722, 363] = (241, 223, 255)
    image[723, 363] = (242, 227, 255)

    result = detect_red_spot(image)

    assert result['x'] * 719 == pytest.approx(363, abs=.75)
    assert result['y'] * 1279 == pytest.approx(723, abs=.75)
    assert result['candidate_count'] == 1
    assert result['physically_verified'] is False


def test_warm_white_reflection_does_not_become_a_pale_pink_spot():
    image = frame(720, 1280)
    cv2.ellipse(image, (363, 723), (2, 3), 0, 0, 360, (225, 230, 255), -1)
    with pytest.raises(ValueError, match='No clear compact'):
        detect_red_spot(image)


def irregular_bloom(image, point):
    outline = np.array([[-95, -60], [15, -12], [112, 54], [9, 24], [-32, 38], [-51, -11]])
    cv2.fillPoly(image, [outline + np.array(point)], (35, 30, 245))
    cv2.circle(image, point, 25, (65, 35, 250), -1)


@pytest.mark.parametrize('core_colour', [(245, 245, 245), (242, 218, 255)])
def test_compact_core_is_resolved_inside_large_irregular_red_bloom(core_colour):
    image = frame(720, 1280)
    point = (364, 727)
    irregular_bloom(image, point)
    cv2.circle(image, point, 6, core_colour, -1)
    image = cv2.GaussianBlur(image, (3, 3), .6)
    original = image.copy()

    result = detect_red_spot(image)

    assert result['x'] * 719 == pytest.approx(point[0], abs=1.)
    assert result['y'] * 1279 == pytest.approx(point[1], abs=1.)
    assert 3 < result['radius_px'] < 8
    assert result['candidate_count'] == 1
    assert result['physically_verified'] is False
    np.testing.assert_array_equal(image, original)


def test_two_compact_cores_in_shared_bloom_remain_ambiguous():
    image = frame(720, 1280)
    for point in ((330, 725), (395, 725)):
        irregular_bloom(image, point)
    for point in ((330, 725), (395, 725)):
        cv2.circle(image, point, 6, (240, 235, 250), -1)

    with pytest.raises(ValueError, match='Multiple plausible'):
        detect_red_spot(image)
    selected = detect_red_spot(image, (330 / 719, 725 / 1279))
    assert selected['x'] * 719 == pytest.approx(330, abs=1.)
    assert selected['candidate_count'] == 2


def test_nearby_red_wire_does_not_authorize_an_unrelated_white_glare_core():
    image = frame(720, 1280)
    cv2.line(image, (348, 650), (348, 790), (20, 20, 250), 4)
    cv2.circle(image, (364, 727), 6, (250, 250, 250), -1)
    with pytest.raises(ValueError, match='No clear compact'):
        detect_red_spot(image)


def test_irregular_red_bloom_without_a_bright_core_remains_rejected():
    image = frame(720, 1280)
    irregular_bloom(image, (364, 727))
    with pytest.raises(ValueError, match='No clear compact'):
        detect_red_spot(image)


def test_warm_reflection_core_inside_red_bloom_is_not_selected():
    image = frame(720, 1280)
    irregular_bloom(image, (364, 727))
    cv2.circle(image, (364, 727), 6, (225, 230, 255), -1)
    with pytest.raises(ValueError, match='No clear compact'):
        detect_red_spot(image)


def test_asymmetric_compact_halo_does_not_pull_marker_away_from_bright_core():
    image = frame(720, 1280)
    cv2.ellipse(image, (355, 727), (18, 12), 0, 0, 360, (35, 30, 245), -1)
    cv2.circle(image, (366, 727), 4, (245, 245, 250), -1)

    result = detect_red_spot(image)

    assert result['x'] * 719 == pytest.approx(366, abs=1.)
    assert result['y'] * 1279 == pytest.approx(727, abs=1.)
    assert result['radius_px'] > 10  # Keep the halo extent while locating its core.
    assert result['candidate_count'] == 1


def test_seed_selects_nearby_candidate_and_preserves_total_count():
    image = frame()
    spot(image, (350, 200))
    spot(image, (800, 460))
    result = detect_red_spot(image, (790 / 1279, 468 / 719))
    assert result['x'] == pytest.approx(800 / 1279, abs=1 / 1279)
    assert result['y'] == pytest.approx(460 / 719, abs=1 / 719)
    assert result['candidate_count'] == 2
    with pytest.raises(ValueError, match='near the selected point'):
        detect_red_spot(image, (0.05, 0.05))


def test_two_candidates_near_seed_remain_ambiguous():
    image = frame()
    spot(image, (600, 360), radius=5)
    spot(image, (630, 360), radius=5)
    with pytest.raises(ValueError, match='Multiple plausible'):
        detect_red_spot(image, (615 / 1279, 360 / 719))


def test_tight_source_pixel_seed_excludes_secondary_core_without_changing_default():
    image = frame(720, 1280)
    irregular_bloom(image, (360, 720))
    for point in ((360, 720), (382, 720)):
        cv2.circle(image, point, 3, (245, 235, 250), -1)
    seed = (360 / 719, 720 / 1279)
    with pytest.raises(ValueError, match='Multiple plausible'):
        detect_red_spot(image, seed)

    result = detect_red_spot(image, seed, seed_radius_px=12.8)

    assert result['x'] * 719 == pytest.approx(360, abs=.5)
    assert result['y'] * 1279 == pytest.approx(720, abs=.5)
    assert result['candidate_count'] == 2
    assert result['physically_verified'] is False
    with pytest.raises(ValueError, match='near the selected point'):
        detect_red_spot(image, (360 / 719, 745 / 1279), seed_radius_px=12.8)


def test_two_cores_inside_tight_pixel_seed_still_reject_ambiguity():
    image = frame(720, 1280)
    irregular_bloom(image, (360, 720))
    for point in ((360, 720), (370, 720)):
        cv2.circle(image, point, 3, (245, 235, 250), -1)
    with pytest.raises(ValueError, match='Multiple plausible'):
        detect_red_spot(image, (360 / 719, 720 / 1279), seed_radius_px=12)


@pytest.mark.parametrize('pixel_offset', [(0, 11), (11, 0)])
def test_pixel_seed_radius_has_equal_scale_on_portrait_axes(pixel_offset):
    image = frame(720, 1280)
    spot(image, (360, 720), radius=5)
    seed = ((360 + pixel_offset[0]) / 719, (720 + pixel_offset[1]) / 1279)
    assert detect_red_spot(image, seed, seed_radius_px=12)['candidate_count'] == 1
    with pytest.raises(ValueError, match='near the selected point'):
        detect_red_spot(image, seed, seed_radius_px=10)


@pytest.mark.parametrize('radius', [0, -1, 1281, float('nan'), float('inf'), True, '12', np.complex64(12)])
def test_invalid_source_pixel_radius_is_rejected(radius):
    with pytest.raises(ValueError, match='seed radius'):
        detect_red_spot(frame(720, 1280), (.5, .5), seed_radius_px=radius)


def test_source_pixel_radius_requires_an_explicit_seed():
    with pytest.raises(ValueError, match='seed radius'):
        detect_red_spot(frame(), seed_radius_px=12)


@pytest.mark.parametrize('shape', ['blank', 'wire', 'patch', 'large_circle', 'white_glare', 'edge'])
def test_rejects_blank_wire_broad_red_areas_glare_and_clipped_spots(shape):
    image = frame()
    if shape == 'wire':
        cv2.line(image, (200, 300), (1050, 310), (5, 10, 255), 5)
    elif shape == 'patch':
        cv2.rectangle(image, (300, 200), (500, 450), (10, 10, 255), -1)
    elif shape == 'large_circle':
        cv2.circle(image, (400, 350), 60, (15, 15, 255), -1)
    elif shape == 'white_glare':
        cv2.circle(image, (400, 350), 8, (255, 255, 255), -1)
    elif shape == 'edge':
        spot(image, (0, 300))
    with pytest.raises(ValueError, match='No clear compact red spot'):
        detect_red_spot(image)


@pytest.mark.parametrize('width,height,point,radius', [
    (720, 1280, (200, 950), 10),
    (3840, 2160, (3017, 1793), 27),
    (320, 240, (221, 171), 5),
])
def test_portrait_high_resolution_and_small_frames_preserve_geometry(width, height, point, radius):
    image = frame(width, height)
    spot(image, point, radius=radius)
    result = detect_red_spot(image)
    assert abs(result['x'] * (width - 1) - point[0]) < 1.5
    assert abs(result['y'] * (height - 1) - point[1]) < 1.5
    assert radius * 0.7 < result['radius_px'] < radius * 1.15


@pytest.mark.parametrize('image', [None, [], np.zeros((3, 3, 3), dtype=np.uint8),
    np.zeros((100, 100), dtype=np.uint8), np.zeros((100, 100, 4), dtype=np.uint8),
    np.zeros((100, 100, 3), dtype=float)])
def test_rejects_invalid_images(image):
    with pytest.raises(ValueError, match='valid uint8 BGR'):
        detect_red_spot(image)


@pytest.mark.parametrize('seed', [[], (0.1,), (0.1, 0.2, 0.3), (float('nan'), 0.1),
    (float('inf'), 0.1), (True, 0.1), (-0.1, 0.1), (0.1, 1.1), ('0.2', 0.1),
    (np.complex64(0.2), 0.1)])
def test_rejects_invalid_selection(seed):
    with pytest.raises(ValueError, match='normalized x/y'):
        detect_red_spot(frame(), seed)
