from types import SimpleNamespace
import pytest
from ohmpath_pi.camera_worker import focus_and_lock


CONTROLS = SimpleNamespace(AfModeEnum=SimpleNamespace(Manual=0), AfStateEnum=SimpleNamespace(Scanning=1))


class Camera:
    def __init__(self, success=True, position=4.25):
        self.success = success
        self.position = position
        self.settings = None
    def autofocus_cycle(self, wait):
        assert wait is False
        return 'job'
    def wait(self, job, timeout):
        assert job == 'job' and timeout == 7
        return self.success
    def capture_metadata(self):
        return {'LensPosition':self.position, 'AfState':2}
    def set_controls(self, settings): self.settings = settings


@pytest.mark.parametrize('success', [True, False])
def test_focus_locks_measured_lens_without_inventing_focus_success(success):
    camera = Camera(success)
    assert focus_and_lock(camera, CONTROLS) == (4.25, success)
    assert camera.settings == {'AfMode':0, 'LensPosition':4.25}


@pytest.mark.parametrize('position', [float('nan'), float('inf'), -1, True])
def test_invalid_focus_is_not_streamed(position):
    camera = Camera(position=position)
    with pytest.raises(RuntimeError): focus_and_lock(camera, CONTROLS)
    assert camera.settings is None
