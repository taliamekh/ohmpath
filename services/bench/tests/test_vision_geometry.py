import pytest

from ohmpath.vision import (
    BoardCalibration, GeometryError, SemanticTarget, TargetRegistry, ZoomTransform,
    apply_homography, homography_from_points, project_target, rotation_transform,
)


def calibration(**changes):
    fields = dict(
        camera_id="pi", board_id="board", board_revision="b1", calibration_revision="c1",
        plane_id="worktop", plane_depth_mm=100.0, max_depth_delta_mm=2.0,
        board_to_frame=((2, 0, 10), (0, 2, 20), (0, 0, 1)),
    )
    fields.update(changes)
    return BoardCalibration(**fields)


def target(**changes):
    fields = dict(
        target_id="tp-1", board_id="board", board_revision="b1", plane_id="worktop",
        x_mm=5.0, y_mm=7.0, depth_mm=100.0, linked_node_id="n1", calibration_revision="c1",
    )
    fields.update(changes)
    return SemanticTarget(**fields)


def test_zoom_transform_is_reversible_and_does_not_change_board_map():
    zoom = ZoomTransform(scale=2.5, offset_x=13, offset_y=-7)
    screen = zoom.to_screen((100, 40))
    assert zoom.from_screen(screen) == pytest.approx((100, 40))
    assert apply_homography(calibration().board_to_frame, (5, 7)) == (20, 34)


def test_rotation_transforms_source_pixels_and_accounts_for_swapped_dimensions():
    matrix, output_size = rotation_transform(640, 480, 90)
    assert output_size == (480, 640)
    assert apply_homography(matrix, (0, 0)) == (479, 0)
    assert apply_homography(matrix, (639, 479)) == (0, 639)


def test_anchor_fit_and_manual_correction_create_separate_revision():
    source = [(0, 0), (100, 0), (100, 80), (0, 80)]
    destination = [(10, 20), (210, 20), (210, 180), (10, 180)]
    fitted = homography_from_points(source, destination)
    assert apply_homography(fitted, (25, 40)) == pytest.approx((60, 100))
    corrected = calibration().manually_corrected(source, destination, calibration_revision="c2")
    assert corrected.mapping_source == "manual_correction"
    assert corrected.calibration_revision == "c2"


def test_bad_anchor_geometry_and_depth_plane_or_revision_mismatch_are_rejected():
    with pytest.raises(GeometryError):
        homography_from_points([(0, 0), (1, 0), (2, 0), (3, 0)], [(0, 0), (1, 0), (2, 0), (3, 0)])
    with pytest.raises(GeometryError, match="depth"):
        project_target(target(depth_mm=105), calibration(), camera_id="pi", board_revision="b1", plane_id="worktop")
    with pytest.raises(GeometryError, match="plane"):
        project_target(target(plane_id="raised"), calibration(), camera_id="pi", board_revision="b1", plane_id="raised")
    with pytest.raises(GeometryError, match="stale"):
        project_target(target(), calibration(), camera_id="pi", board_revision="b2", plane_id="worktop")
    with pytest.raises(GeometryError, match="stale"):
        project_target(target(calibration_revision="old"), calibration(), camera_id="pi", board_revision="b1", plane_id="worktop")


def test_target_registry_invalidates_board_and_calibration_revisions():
    registry = TargetRegistry()
    registry.put(target())
    registry.set_context(board_revision="b1", calibration_revision="c1")
    assert registry.resolve("tp-1") == target()
    registry.invalidate_board("b2")
    with pytest.raises(GeometryError, match="board revision"):
        registry.resolve("tp-1")
    registry.set_context(board_revision="b1", calibration_revision="c1")
    registry.invalidate_calibration("c2")
    with pytest.raises(GeometryError, match="calibration revision"):
        registry.resolve("tp-1")


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_calibration_cannot_bypass_depth_gate(bad):
    with pytest.raises(GeometryError):
        target(depth_mm=bad)
    with pytest.raises(GeometryError):
        calibration(max_depth_delta_mm=bad)
    with pytest.raises(GeometryError):
        ZoomTransform(offset_x=bad)
    with pytest.raises(GeometryError):
        homography_from_points([(0, 0), (1, 0), (1, 1), (0, bad)], [(0, 0), (1, 0), (1, 1), (0, 1)])


def test_registry_requires_explicit_current_context():
    registry = TargetRegistry()
    registry.put(target())
    with pytest.raises(GeometryError, match="context"):
        registry.resolve("tp-1")


def test_nearly_collinear_anchors_and_silent_target_replacement_are_rejected():
    points = [(0, 0), (100, 0), (200, 1e-8), (300, 0)]
    with pytest.raises(GeometryError):
        homography_from_points(points, points)
    registry = TargetRegistry()
    registry.put(target())
    with pytest.raises(GeometryError, match="revision"):
        registry.put(target(x_mm=10))
    registry.put(target(x_mm=10, calibration_revision="c2"))


def test_anchor_fit_handles_large_coordinate_offsets():
    points = [(100000, 200000), (100100, 200000), (100100, 200080), (100000, 200080)]
    destination = [(10, 20), (210, 20), (210, 180), (10, 180)]
    transform = homography_from_points(points, destination)
    assert apply_homography(transform, (100025, 200040)) == pytest.approx((60, 100))
