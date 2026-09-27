"""Whole tour orchestration with a synthetic camera and in-memory motor outputs."""
import time
import threading
from copy import deepcopy

import cv2
import numpy as np
import pytest

from ohmpath.devices.turret import Turret
from ohmpath_pi.motion_state import MotionState, DEFAULT_PROFILE
from test_turret_scene import texture


class Driver:
    def __init__(self): self.outputs=[]
    def arm(self, positions): self.outputs.append(tuple(positions))
    def move(self, positions): self.outputs.append(tuple(positions))
    def release(self): pass
    def power_flags(self): return 0


class Control:
    def __init__(self): self.motion=MotionState(Driver());self.count=0;self.requests=[]
    def request(self, op, body=None):
        self.count+=1;self.requests.append(op)
        return self.motion.request({'id':f'tour-test-{self.count:06d}','op':op,'body':body or {},
            'epoch':self.motion.epoch,'revision':self.motion.revision})['status']
    def close(self): pass


class Identifier:
    def start(self, context, image_id, jpeg):
        self.image_id=image_id;self.context=context;self.jpeg=jpeg;self.cancelled=False
        return {'turn_id':'identification-turn'}
    def status(self, turn_id):
        return {'status':'completed','answer':{'annotations':[
            {'image_id':self.image_id,'x':.47,'y':.50,'label':'Resistor A'},
            {'image_id':self.image_id,'x':.53,'y':.54,'label':'Capacitor B'}]}}
    def cancel(self, context): self.cancelled=True


class Video:
    generation='synthetic-tour-camera'
    def __init__(self, control):
        self.control=control; self.sequence=0;self.closed=False
        self.reference=texture(640,480)
        rng=np.random.default_rng(17)
        for x,y in ((.47,.50),(.53,.54)):
            px,py=round(x*639),round(y*479)
            self.reference[py-15:py+15,px-15:px+15]=rng.integers(10,240,(30,30,3),dtype=np.uint8)
    def frame(self):
        if self.closed: return None
        self.sequence+=1
        yaw,pitch=self.control.motion.position
        transform=np.float32([[1,0,.5*(yaw-1500)],[0,1,.4*(pitch-1500)]])
        return {'image':cv2.warpAffine(self.reference,transform,(640,480)),
            'sequence':self.sequence,'generation':self.generation,'received':time.monotonic(),'age':0}
    def close(self): self.closed=True


def ready(tmp_path):
    identifier=Identifier()
    turret=Turret(tmp_path,identifier=identifier)
    turret.control=Control();turret.video=Video(turret.control)
    turret.state=turret.control.motion.status();turret.keepalive()
    frame=turret._frame()
    turret.identify_components({'x':0.,'y':0.,'width':1.,'height':1.},frame['sequence'],frame['generation'])
    turret.component_map.update(turret._frame(),turret._context())
    turret.approve_components(turret.component_map.map_id)
    turret.set_aim_reference(.50,.55,300,turret._frame()['sequence'],turret.video.generation)
    return turret


def test_tour_visits_identified_components_in_order_and_calibrates_without_model_motor_commands(tmp_path, monkeypatch):
    turret=ready(tmp_path)
    turret.arm(clear=True,laser_disconnected=True,commissioning=True)
    expected=[c['id'] for c in turret.component_map.components]
    def settle(cancel, timeout=2.5):
        with turret.lock:
            turret._check_job(cancel)
            # Instantaneous simulated actuator only; no physical driver or time claim.
            motion=turret.control.motion
            motion.position=list(motion.target)
            motion.driver.move(motion.position)
            turret.state=motion.status()
            frame=turret._frame()
            turret.point=turret.tracker.update(frame);turret.point_sequence=frame['sequence']
            return turret.point.copy()
    monkeypatch.setattr(turret,'_settle',settle)
    turret.start_tour(turret.component_map.map_id)
    deadline=time.monotonic()+18
    while turret.job_thread.is_alive() and time.monotonic()<deadline:
        with turret.lock:
            turret.presence=time.monotonic();turret._request('heartbeat')
            frame=turret._frame()
            turret.component_map.update(frame,turret._context())
            if turret.tracker:
                turret.point=turret.tracker.update(frame);turret.point_sequence=frame['sequence']
        time.sleep(.025)
    turret.job_thread.join(.5)
    assert turret.tour['state']=='completed', turret.status()
    assert turret.tour['visited']==expected
    assert turret.calibration and turret.status()['laser_enabled'] is False
    assert not turret.state['commissioning']
    assert 'move' in turret.control.requests
    for yaw,pitch in turret.control.motion.driver.outputs:
        assert DEFAULT_PROFILE['yaw']['min']<=yaw<=DEFAULT_PROFILE['yaw']['max']
        assert DEFAULT_PROFILE['pitch']['min']<=pitch<=DEFAULT_PROFILE['pitch']['max']
    turret.close()


def test_map_identification_does_not_arm_and_explicit_enable_allows_external_laser(tmp_path):
    turret=ready(tmp_path)
    assert turret.component_map.approved
    assert not turret.control.motion.driver.outputs
    with pytest.raises(ValueError,match='Enable movement'):
        turret.start_tour(turret.component_map.map_id)
    assert not turret.control.motion.driver.outputs
    assert turret.arm(clear=True,laser_disconnected=False,commissioning=False)['armed']
    turret.close()


def test_missing_or_old_laser_reference_cannot_start_tour(tmp_path):
    turret=ready(tmp_path)
    turret.arm(clear=True,laser_disconnected=True,commissioning=False)
    turret.aim_reference['generation']='old-camera'
    before=list(turret.control.motion.driver.outputs)
    with pytest.raises(ValueError,match='laser reference'):
        turret.start_tour(turret.component_map.map_id)
    assert turret.control.motion.driver.outputs==before and turret.phase=='idle'
    turret.close()
