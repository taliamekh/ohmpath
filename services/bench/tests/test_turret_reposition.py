"""Autonomous framing using synthetic camera motion and in-memory outputs only."""
import threading
import time

import pytest

from ohmpath.devices.turret import Turret
from test_turret_tour import Control, Video


def ready(tmp_path):
    turret=Turret(tmp_path)
    turret.control=Control();turret.video=Video(turret.control)
    turret.profile={'yaw':{'min':1380,'max':2055,'home':1500},
                    'pitch':{'min':1500,'max':2492,'home':2004}}
    turret._request('profile',{'profile':turret.profile})
    turret.keepalive()
    return turret


def mark(turret,roi=None):
    frame=turret._frame()
    return turret.prepare_framing(roi or {'x':.02,'y':.4,'width':.32,'height':.35},
                                  frame['sequence'],frame['generation'])['framing']['framing_id']


def simulate_feedback(turret,monkeypatch):
    def settle(cancel,timeout=2.5):
        with turret.lock:
            turret._check_job(cancel)
            motion=turret.control.motion
            motion.position=list(motion.target)
            motion.driver.move(motion.position)
            turret.state=motion.status()
            frame=turret._frame()
            turret.point=turret.tracker.update(frame);turret.point_sequence=frame['sequence']
            return turret.point.copy()
    monkeypatch.setattr(turret,'_settle',settle)


def run_feedback(turret):
    deadline=time.monotonic()+12
    while turret.job_thread.is_alive() and time.monotonic()<deadline:
        with turret.lock:
            turret.presence=time.monotonic();turret._request('heartbeat')
            frame=turret._frame()
            if turret.framing_tracker:turret.framing_tracker.update(frame)
            if turret.tracker:
                turret.point=turret.tracker.update(frame);turret.point_sequence=frame['sequence']
        time.sleep(.025)
    turret.job_thread.join(.5)
    assert not turret.job_thread.is_alive(), 'Synthetic framing did not finish'


def test_prepare_tracks_scene_without_output_and_disarmed_start_is_rejected(tmp_path):
    turret=ready(tmp_path)
    ident=mark(turret)
    assert turret.status()['framing']['state']=='ready'
    assert turret.control.motion.driver.outputs==[]
    with pytest.raises(ValueError,match='Enable movement'):
        turret.reposition(ident)
    assert turret.control.motion.driver.outputs==[]
    turret.close()


def test_reposition_centres_edge_region_across_calibration_neighborhoods(tmp_path,monkeypatch):
    turret=ready(tmp_path)
    turret.arm(clear=True,laser_disconnected=True,commissioning=True)
    turret.control.motion.position=list(turret.control.motion.target)
    turret.state=turret.control.motion.status()
    ident=mark(turret)
    simulate_feedback(turret,monkeypatch)
    turret.reposition(ident)
    run_feedback(turret)
    result=turret.status()
    assert result['framing']['state']=='completed', result
    assert result['framing']['centre']['x']==pytest.approx(.5,abs=.01)
    assert result['framing']['centre']['y']==pytest.approx(.5,abs=.015)
    assert turret.calibration and result['commissioning'] is False
    assert turret.state['commanded_us']['yaw']>1850
    assert result['laser_enabled'] is False
    for output in turret.control.motion.driver.outputs:
        for axis,value in zip(('yaw','pitch'),output):
            assert turret.profile[axis]['min']<=value<=turret.profile[axis]['max']
    turret.close()


def test_old_selection_cannot_start_new_framing(tmp_path):
    turret=ready(tmp_path)
    ident=mark(turret)
    turret.arm(clear=True,laser_disconnected=True,commissioning=False)
    turret.control.motion.position=list(turret.control.motion.target)
    turret.state=turret.control.motion.status()
    mark(turret,{'x':.1,'y':.45,'width':.35,'height':.3})
    before=list(turret.control.motion.driver.outputs)
    with pytest.raises(ValueError,match='current circuit area'):
        turret.reposition(ident)
    assert turret.control.motion.driver.outputs==before
    assert turret.phase=='idle'
    turret.close()


def test_stale_frame_and_generation_rejected_without_replacing_selection(tmp_path):
    turret=ready(tmp_path);ident=mark(turret)
    old=turret._frame()
    for _ in range(7):turret._frame()
    with pytest.raises(ValueError,match='fresh camera'):
        turret.prepare_framing({'x':.1,'y':.1,'width':.5,'height':.5},old['sequence'],old['generation'])
    assert turret.framing['framing_id']==ident
    with pytest.raises(ValueError,match='fresh camera'):
        turret.prepare_framing({'x':.1,'y':.1,'width':.5,'height':.5},old['sequence'],'old-generation')
    assert not turret.control.motion.driver.outputs
    turret.close()


def test_stop_during_framing_prevents_following_worker_output(tmp_path,monkeypatch):
    turret=ready(tmp_path)
    turret.arm(clear=True,laser_disconnected=True,commissioning=False)
    turret.control.motion.position=list(turret.control.motion.target)
    turret.state=turret.control.motion.status()
    ident=mark(turret)
    entered=threading.Event();resume=threading.Event()
    def calibrate(cancel):
        entered.set();resume.wait(2)
        turret._move({'yaw':1550,'pitch':2004},cancel)
    monkeypatch.setattr(turret,'_calibrate',calibrate)
    turret.reposition(ident)
    assert entered.wait(2)
    before=len(turret.control.motion.driver.outputs)
    turret.stop_follow();resume.set();turret.job_thread.join(2)
    assert len(turret.control.motion.driver.outputs)==before
    assert turret.framing['state']=='stopped'
    assert turret.phase=='idle'
    turret.close()
