"""Local user-owned turret runtime, with separate control and camera SSH connections."""
from __future__ import annotations

import base64
from copy import deepcopy
import json
from pathlib import Path
import threading
import time
import uuid

import cv2
import numpy as np

from ohmpath_pi.motion_state import DEFAULT_PROFILE, INITIAL_TEST_PROFILE, profile_checked
from .turret_link import ControlLink, VideoLink, load_pairing
from .turret_vision import PointTracker, advance_camera_map, correction, fit_camera_map
from .turret_targets import ComponentMap
from .turret_spot import detect_red_spot
from .turret_framing import SceneFraming
from .turret_guidance import DiagnosisMap, find_circuit_region


class Turret:
    def __init__(self, data_dir: Path, *, pairing_path: Path | None = None, identifier=None):
        self.path = data_dir / 'turret-profile.json'
        # AppData can be redirected for packaged tools and their child processes.
        # The user-profile location is shared with Ohm Path launched from Explorer.
        self.pairing_path = pairing_path or Path.home() / '.ohmpath/hardware-setup/connection.json'
        self.lock = threading.RLock()
        self.control: ControlLink | None = None
        self.video: VideoLink | None = None
        self.profile = deepcopy(DEFAULT_PROFILE)
        self.orientation = 0
        migrated_range = False
        try:
            saved = json.loads(self.path.read_text())
            self.profile = profile_checked(saved['profile'])
            if saved.get('manual_range_revision', 1) == 1 and all(self.profile[a][k] == INITIAL_TEST_PROFILE[a][k]
                   for a in ('yaw', 'pitch') for k in ('min', 'max')):
                for axis in ('yaw', 'pitch'):
                    self.profile[axis].update(min=DEFAULT_PROFILE[axis]['min'], max=DEFAULT_PROFILE[axis]['max'])
                migrated_range = True
            if saved.get('orientation') in (0, 90, 180, 270):
                self.orientation = saved['orientation']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        self.state: dict = {}
        self.message = 'Connect the paired Pi to open its camera. Movement starts disabled.'
        self.presence = 0.0
        self.stop_event = threading.Event()
        self.loop_thread: threading.Thread | None = None
        self.job_cancel = threading.Event()
        self.job_thread: threading.Thread | None = None
        self.phase = 'idle'
        self.tracker: PointTracker | None = None
        self.point = None
        self.point_sequence = -1
        self.calibration = None
        self.connecting = False
        self.connection_generation = 0
        self.aim_reference = None
        self.drive_session = str(uuid.uuid4())
        self.drive_sequence = -1
        self.preview_key = None
        self.preview_spot = None
        self.preview_spot_message = ''
        self.preview_encoded = None
        self.identifier = identifier
        self.component_map = None
        self.tour = None
        self.job_deadline = None
        self.framing_tracker = None
        self.framing = None
        self.guidance = None
        self.refreshing_camera = False
        self.camera_refresh_token = None
        self._observation_holds = set()
        if migrated_range:
            self._save()

    def connect(self, *, expected_generation=None):
        with self.lock:
            if expected_generation is not None and expected_generation != self.connection_generation:
                raise ValueError('Refocus cancelled.')
            if self.control or self.connecting:
                raise ValueError('The turret is already connected or connecting.')
            self.connecting = True
            generation = self.connection_generation
        control = video = None
        try:
            pairing = load_pairing(self.pairing_path)
            control = ControlLink(pairing)
            control.start()
            state = control.request('profile', {'profile': self.profile})
            video = VideoLink(pairing)
            video.start()
            deadline = time.monotonic() + 12
            while video.frame() is None:
                if video.error or time.monotonic() > deadline:
                    raise RuntimeError(video.error or 'The Pi camera did not produce a fresh frame.')
                time.sleep(0.05)
            with self.lock:
                if generation != self.connection_generation:
                    raise ValueError('Connection cancelled.')
                self.control, self.video, self.state = control, video, state
                self.calibration = None
                self.tracker = None
                self.point = None
                self.aim_reference = None
                self.stop_event = threading.Event()
                self.presence = time.monotonic()
                self.message = 'Connected with motors released. Identify the circuit or set its laser reference.'
                self.loop_thread = threading.Thread(target=self._loop, args=(self.stop_event,), name='turret-supervisor', daemon=True)
                self.loop_thread.start()
            return self.status()
        except Exception:
            if video:
                video.close()
            if control:
                control.close()
            raise
        finally:
            self.connecting = False

    def _request(self, op: str, body=None):
        if self.control is None:
            raise ValueError('Connect the Pi first.')
        self.state = self.control.request(op, body)
        return self.state

    def keepalive(self):
        with self.lock:
            self.presence = time.monotonic()
            return self.status()

    def status(self):
        with self.lock:
            frame = self._frame()
            return {'connected': self.control is not None, 'connecting': self.connecting,
                    'armed': self.state.get('armed', False), 'moving': self.state.get('moving', False),
                    'holding': self.state.get('holding', False), 'commissioning': self.state.get('commissioning', False),
                    'driving': self.state.get('driving', False), 'drive_session': self.drive_session,
                    'manual_bounds_us': self.state.get('manual_bounds_us'),
                    'signal_bounds_us': self.state.get('signal_bounds_us'),
                    'active_bounds_us': self.state.get('active_bounds_us'), 'at_limit': self.state.get('at_limit', {}),
                    'commanded_us': self.state.get('commanded_us'), 'target_us': self.state.get('target_us'),
                    'position_verified': False, 'profile': self.profile, 'orientation': self.orientation,
                    'message': self.state.get('fault') or self.message, 'phase': self.phase,
                    'camera_ready': frame is not None, 'calibrated': self._calibration_valid(),
                    'camera_focus_success': frame.get('focus_success') if frame else None,
                    'calibration': ({k: v for k, v in self.calibration.items() if k not in ('matrix', 'context')}
                                    if self.calibration else None),
                    'target_selected': self.point is not None, 'laser_enabled': False,
                    'laser_power_state': 'external_unknown',
                    'laser_control_available': False, 'aim_reference': self.aim_reference,
                    'component_map': self.component_map.summary() if self.component_map else None,
                    'tour': deepcopy(self.tour), 'framing': self._framing_status(),
                    'guidance': deepcopy(self.guidance)}

    def _framing_status(self):
        if self.framing is None:
            return None
        geometry = self.framing_tracker.summary()
        result = {**geometry, **deepcopy(self.framing), 'geometry_state':geometry['state']}
        if geometry['state'] != 'registered' or not geometry['geometry_current'] or not geometry['fits_with_margin']:
            result.update(state='lost', message=geometry['message'])
        return result

    def _frame(self):
        frame = self.video.frame() if self.video else None
        if frame is None:
            return None
        image = frame['image']
        if self.orientation:
            image = cv2.rotate(image, {90: cv2.ROTATE_90_CLOCKWISE,
                                      180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[self.orientation])
        return {**frame, 'image': image}

    def frame(self):
        with self.lock:
            frame = self._frame()
            if frame is None:
                return {'frame': None}
            height, width = frame['image'].shape[:2]
            key = (frame['generation'], frame['sequence'], self.orientation)
            if key != self.preview_key:
                if self.orientation == 0 and frame.get('jpeg'):
                    raw = frame['jpeg']
                else:
                    ok, encoded = cv2.imencode('.jpg', frame['image'], [cv2.IMWRITE_JPEG_QUALITY, 95])
                    if not ok:
                        raise ValueError('Could not display the camera frame.')
                    raw = encoded.tobytes()
                self.preview_encoded = base64.b64encode(raw).decode()
                self.preview_key = key
                # This marker belongs to the displayed exposure. A remembered
                # reference or camera centre must never masquerade as its beam.
                try:
                    self.preview_spot = self._detect_spot(frame)
                    self.preview_spot_message = 'Laser spot observed in this image.'
                except ValueError as exc:
                    self.preview_spot = None
                    self.preview_spot_message = str(exc)
            point = None
            if self.point is not None and self.point_sequence == frame['sequence']:
                point = {'x': float(self.point[0] / (width - 1)), 'y': float(self.point[1] / (height - 1))}
            return {'frame': {'jpeg_base64': self.preview_encoded,
                              'sequence': frame['sequence'], 'generation': frame['generation'],
                              'width': width, 'height': height, 'target': point,
                              'laser_spot': self.preview_spot, 'laser_spot_message': self.preview_spot_message}}

    def _loop(self, stop_event):
        while not stop_event.wait(0.12):
            try:
                with self.lock:
                    if self.control is None or stop_event.is_set():
                        return
                    if time.monotonic() - self.presence > 0.9:
                        if self.state.get('armed'):
                            self._cancel('Control released because this page stopped responding.')
                            self._request('release')
                            self.message = 'Control released because this page stopped responding.'
                        continue
                    self._request('heartbeat')
                    if self.refreshing_camera:
                        # The controlled refocus worker keeps motors holding;
                        # its own deadline/cancellation guards the camera swap.
                        continue
                    frame = self._frame()
                    if frame is None:
                        self._cancel('Camera frames stopped. Reconnect before moving.')
                        self.tracker = None
                        self.point = None
                        self.calibration = None
                        if self.state.get('armed'):
                            self._request('release')
                        self.message = 'Camera frames stopped. Reconnect before moving.'
                        continue
                    if self.observation_paused:
                        # A bounded move owns registration until its ramp and
                        # quiet period end. Heartbeat and camera freshness above
                        # remain live; its settled frame must revalidate targets.
                        continue
                    if self.component_map:
                        self.component_map.update(frame, self._context())
                        if self.component_map.phase == 'lost' and self.phase in ('tour', 'guiding'):
                            self._cancel(self.component_map.message)
                            self._request('hold')
                            self.message = self.component_map.message
                    if self.framing_tracker and self.framing['state'] != 'lost':
                        try:
                            self.framing_tracker.update(frame)
                        except ValueError as exc:
                            self.framing.update(state='lost', message=str(exc))
                            if self.phase == 'repositioning':
                                self._cancel()
                                self._request('hold')
                                self.message = str(exc)
                    if self.tracker:
                        try:
                            self.point = self.tracker.update(frame)
                            self.point_sequence = frame['sequence']
                        except ValueError as exc:
                            self._cancel(str(exc))
                            self.tracker = None
                            self.point = None
                            self._request('hold')
                            self.message = str(exc)
            except Exception as exc:
                with self.lock:
                    self._cancel()
                    self.message = 'Control connection lost: ' + str(exc)[:200]
                    self.state = {**self.state, 'armed': False, 'holding': False}
                    control, self.control = self.control, None
                    video, self.video = self.video, None
                    self.calibration = self.aim_reference = None
                if control:
                    control.close()
                if video:
                    video.close()
                return

    def _cancel(self, reason=None):
        self.job_cancel.set()
        self.job_cancel = threading.Event()
        self.phase = 'idle'
        self.drive_session = str(uuid.uuid4())
        self.drive_sequence = -1
        self.job_deadline = None
        if self.tour and self.tour['state'] == 'running':
            self.tour['state'] = 'stopped'
        if self.framing and self.framing['state'] == 'running':
            self.framing.update(state='stopped', message='Camera repositioning stopped.')
        if self.guidance and self.guidance['state'] == 'running':
            self.guidance.update(state='stopped', message=reason or 'Automatic guidance stopped.')
            if reason:
                self.guidance['reason'] = reason
            if self.component_map and self.component_map.phase == 'identifying':
                self.component_map.close()

    def _clear_map(self):
        if self.component_map:
            self.component_map.close()
        self.component_map = None
        self.tour = None
        self.framing_tracker = None
        self.framing = None

    def prepare_framing(self, roi: dict, sequence: int, generation: str):
        with self.lock:
            frame = self._frame()
            if self.phase != 'idle' or self.state.get('moving') or self.state.get('driving'):
                raise ValueError('Wait for movement to stop before marking the circuit area.')
            if frame is None or frame['generation'] != generation or not 0 <= frame['sequence'] - sequence <= 6:
                raise ValueError('Mark the circuit area on a fresh camera view.')
            tracker = SceneFraming(frame, roi)
            # Publish only after the proposed region validates; this never arms.
            self.framing_tracker = tracker
            self.framing = {'framing_id':str(uuid.uuid4()), 'state':'ready',
                            'message':'Circuit area marked. Centre circuit in view will track and reposition it.'}
            return self.status()

    def reposition(self, framing_id: str):
        with self.lock:
            frame = self._frame()
            if (self.phase != 'idle' or not self.state.get('armed') or frame is None
                    or self.state.get('moving') or self.state.get('driving')
                    or time.monotonic() - self.presence > 0.9):
                raise ValueError('Enable movement and let it settle before centring the marked circuit.')
            if not self.framing or self.framing['framing_id'] != framing_id or self.framing['state'] == 'lost':
                raise ValueError('Mark a current circuit area before centring it.')
            point = self.framing_tracker.update(frame)
            if self.state.get('commissioning'):
                self._request('teaching', {'enabled':False})
            self.tracker, self.point = self.framing_tracker, point
            self.point_sequence = frame['sequence']
            self._start_job('repositioning', self._reposition)
            self.framing.update(state='running', message='Calibrating and centring the marked circuit area…')
            self.job_deadline = time.monotonic() + 120
            return self.status()

    def _reposition(self, cancel):
        with self.lock:
            self._check_job(cancel)
            calibrated = self._calibration_valid()
        if not calibrated:
            self._calibrate(cancel)
        self._follow(cancel, (.5,.5), recalibrate=True, timeout=90)
        with self.lock:
            self._check_job(cancel)
            self.framing.update(state='completed', message='Marked circuit area centred. Identify components in the new view.')
            self.message = self.framing['message']

    def identify_components(self, roi: dict | None = None, sequence: int | None = None,
                            generation: str | None = None, framing_id: str | None = None):
        with self.lock:
            frame = self._frame()
            if self.state.get('armed') or self.phase != 'idle':
                raise ValueError('Release motors before identifying the circuit area.')
            if frame is None:
                raise ValueError('Choose the circuit area on a fresh camera view.')
            if framing_id is not None:
                if any(value is not None for value in (roi,sequence,generation)):
                    raise ValueError('Choose either a current framing reference or a fresh image region.')
                if not self.framing or self.framing['framing_id'] != framing_id or self.framing['state'] == 'lost':
                    raise ValueError('Mark the current circuit area again before identifying it.')
                # Resolve coordinates against the exact frame being cropped, not a
                # renderer rectangle stamped with a newer preview's sequence.
                self.framing_tracker.update(frame)
                bounds = self.framing_tracker.summary()['bounds']
                left, top = max(0.,bounds['x']), max(0.,bounds['y'])
                roi = {'x':left, 'y':top, 'width':min(1.,bounds['x']+bounds['width'])-left,
                       'height':min(1.,bounds['y']+bounds['height'])-top}
            elif (sequence is None or frame['generation'] != generation
                  or not 0 <= frame['sequence'] - sequence <= 6):
                raise ValueError('Choose the circuit area on a fresh camera view.')
            self._clear_map()
            self.component_map = ComponentMap(frame, roi, self._context(), self.identifier)
            self.message = self.component_map.message
            return self.status()

    def approve_components(self, map_id: str):
        with self.lock:
            frame = self._frame()
            if self.component_map is None or frame is None or self.state.get('armed'):
                raise ValueError('Review the component map with motors released and a fresh camera.')
            self.component_map.approve(map_id, frame, self._context())
            self.message = self.component_map.message
            return self.status()

    def clear_components(self):
        with self.lock:
            self._cancel()
            if self.control:
                self._request('hold')
            self._clear_map()
            self.tracker = None
            self.point = None
            return self.status()

    def stop_follow(self):
        with self.lock:
            self._cancel()
            self._request('hold')
            self.message = ('Movement stopped; the servos are holding their commanded position.'
                            if self.state.get('armed') else 'Movement stopped. Motors remain released.')
            return self.status()

    def release(self):
        with self.lock:
            self._cancel()
            if self.control:
                self._request('release')
            self.message = 'Control released. The mechanism may relax under its own weight.'
            return self.status()

    def arm(self, *, clear: bool = True, commissioning: bool = False, laser_disconnected: bool | None = None):
        with self.lock:
            if not clear or self._frame() is None or time.monotonic() - self.presence > 0.9:
                raise ValueError('Enable control from the current page with a fresh camera view.')
            self._cancel()
            self._request('arm', {'clear': clear, 'commissioning': commissioning})
            self.message = ('Full manual range enabled: saved stops are bypassed. Approach endpoints gradually.' if commissioning
                            else 'Saved travel limits enabled. The servos hold position until released.')
            return self.status()

    def jog(self, axis: str, direction: int, fine: bool):
        with self.lock:
            self._cancel()
            self._request('jog', {'axis': axis, 'direction': direction, 'fine': fine})
            self.message = 'Manual movement requested.'
            return self.status()

    def drive(self, yaw: int, pitch: int, fine: bool, session: str, sequence: int):
        with self.lock:
            if session != self.drive_session or sequence <= self.drive_sequence:
                raise ValueError('Keyboard control changed. Lock the controls again before moving.')
            if not self.state.get('armed') or self.phase != 'idle' or self._frame() is None or time.monotonic() - self.presence > 0.9:
                raise ValueError('Keyboard movement needs an enabled, visible controller and fresh camera.')
            if any(type(v) is not int or v not in (-1, 0, 1) for v in (yaw, pitch)) or type(fine) is not bool:
                raise ValueError('Invalid manual direction.')
            self.drive_sequence = sequence
            # Manual driving has no feature-tracking authority or dependency.
            self.tracker = None
            self.point = None
            self._request('drive', {'yaw': yaw, 'pitch': pitch, 'fine': fine})
            self.message = 'Arrow keys control movement; release the keys to hold position.' if yaw or pitch else 'Keys released. Holding position.'
            return self.status()

    def teaching(self, enabled: bool):
        with self.lock:
            if type(enabled) is not bool or not self.state.get('armed') or self._frame() is None or time.monotonic() - self.presence > 0.9:
                raise ValueError('Enable movement with a fresh camera before teaching travel.')
            self._cancel()
            self._request('hold')
            self._request('teaching', {'enabled': enabled})
            self.tracker = None
            self.point = None
            self.calibration = None
            self.message = ('Full manual range: saved limits are bypassed. Read the live pan and tilt commands; stop before interference.'
                            if enabled else 'Saved travel limits restored. Recalibrate before automatic pointing.')
            return self.status()

    def home(self):
        with self.lock:
            self._cancel()
            self._request('home')
            self.message = 'Returning to saved home and holding there.'
            return self.status()

    def save_position(self, what: str, axis: str | None = None):
        with self.lock:
            if not self.state.get('armed') or self.state.get('moving') or self.state.get('driving') or self.phase != 'idle':
                raise ValueError('Stop at the desired position before saving it.')
            profile = deepcopy(self.profile)
            if what == 'home':
                for name in ('yaw', 'pitch'):
                    profile[name]['home'] = round(self.state['commanded_us'][name])
            elif what in ('min', 'max') and axis in ('yaw', 'pitch'):
                if not self.state.get('commissioning'):
                    raise ValueError('Enable travel setup to teach a new limit.')
                profile[axis][what] = round(self.state['commanded_us'][axis])
            else:
                raise ValueError('Choose home or one axis travel limit.')
            profile_checked(profile)
            self._cancel()
            self._request('profile', {'profile': profile})
            self.profile = profile
            self.calibration = None
            self.aim_reference = None
            self._clear_map()
            self._save()
            self.message = 'Position saved. Recalibrate camera following after changing this setup.'
            return self.status()

    def rotate(self):
        with self.lock:
            if self.state.get('armed'):
                raise ValueError('Release control before rotating the preview.')
            self.orientation = (self.orientation + 90) % 360
            self.calibration = None
            self.tracker = None
            self.point = None
            self.aim_reference = None
            self._clear_map()
            self._save()
            return self.status()

    def refocus(self):
        with self.lock:
            if self.state.get('armed'):
                raise ValueError('Release motors before refocusing the camera.')
            if not self.control or self.connecting:
                raise ValueError('Connect the Pi before refocusing.')
            generation = self.connection_generation + 1
        self.disconnect()
        return self.connect(expected_generation=generation)

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'profile': self.profile, 'orientation': self.orientation, 'manual_range_revision': 2}))
        temporary.replace(self.path)

    def select(self, x: float, y: float, sequence: int, generation: str):
        with self.lock:
            frame = self._frame()
            if frame is None or frame['generation'] != generation or not 0 <= frame['sequence'] - sequence <= 3:
                raise ValueError('That camera view is stale. Select the point again.')
            if self.state.get('moving') or self.state.get('driving'):
                raise ValueError('Let the mechanism settle before selecting a point.')
            self._cancel()
            self.tracker = PointTracker()
            self.point = self.tracker.update(frame, (x, y))
            self.point_sequence = frame['sequence']
            self.message = 'Feature selected. Calibrate here, or follow it with a current calibration.'
            return self.status()

    def _context(self):
        return (self.state.get('revision'), self.state.get('firmware_revision'),
                self.video.generation if self.video else None, self.orientation)

    def set_aim_reference(self, x: float, y: float, distance_mm: int, sequence: int, generation: str):
        with self.lock:
            frame = self._frame()
            if frame is None or frame['generation'] != generation or not 0 <= frame['sequence'] - sequence <= 3:
                raise ValueError('Select the reference on a fresh camera view.')
            if self.state.get('moving') or self.state.get('driving') or self.phase != 'idle':
                raise ValueError('Stop moving before setting the aiming reference.')
            if not 0.05 <= x <= 0.95 or not 0.05 <= y <= 0.95 or not 50 <= distance_mm <= 3000:
                raise ValueError('Choose a visible reference and a working distance from 50 to 3000 mm.')
            self.aim_reference = {'x': x, 'y': y, 'distance_mm': distance_mm,
                                  'source': 'user_reference', 'physically_verified': False,
                                  'generation':frame['generation'], 'orientation':self.orientation}
            self.message = 'Aiming reference saved for this working distance.'
            return self.status()

    def spot_reference(self, sequence: int, generation: str, x=None, y=None):
        with self.lock:
            frame = self._frame()
            if self.state.get('moving') or self.state.get('driving') or self.phase != 'idle':
                raise ValueError('Stop movement before setting the visible laser reference.')
            if frame is None or frame['generation'] != generation or not 0 <= frame['sequence'] - sequence <= 6:
                raise ValueError('Set the spot reference on a fresh camera view.')
            seed = None if x is None and y is None else (x,y)
            observed = detect_red_spot(frame['image'], seed=seed)
            self.aim_reference = {**observed, 'distance_mm':None,
                'generation':frame['generation'], 'orientation':self.orientation,
                'source':'user_selected_red_spot', 'physically_verified':False}
            self.message = 'Laser reference placed on the observed red spot. Valid only at this working surface and distance.'
            return self.status()

    def start_tour(self, map_id: str):
        with self.lock:
            if self.phase != 'idle' or time.monotonic() - self.presence > 0.9:
                raise ValueError('Finish or stop the current action before starting a tour from this page.')
            frame = self._frame()
            if frame is None or not self.state.get('armed'):
                raise ValueError('Enable movement before starting the component tour.')
            if self.component_map is None or self.component_map.map_id != map_id:
                raise ValueError('Choose the current component map.')
            self.component_map.update(frame, self._context())
            if not self.component_map.approved:
                raise ValueError('Review and accept the current component markers first.')
            if not self.aim_reference or self.aim_reference.get('generation') != frame['generation']:
                raise ValueError('Set the laser reference for the current camera view first.')
            if self.state.get('moving') or self.state.get('driving'):
                raise ValueError('Let the current movement stop before starting the tour.')
            if self.state.get('commissioning'):
                self._request('teaching', {'enabled':False})
            ids = [item['id'] for item in self.component_map.components]
            if not ids:
                raise ValueError('The accepted map contains no components.')
            self.tracker = self.component_map.tracker(ids[0])
            self.point = self.tracker.update(frame)
            self.point_sequence = frame['sequence']
            # _start_job is reentrant under the same lock; initialize progress before its worker can run.
            self._start_job('tour', lambda cancel:self._tour(cancel, map_id, ids))
            self.job_deadline = time.monotonic() + 180
            self.tour = {'state':'running','index':0,'total':len(ids),'label':'Calibrating movement','visited':[]}
            return self.status()

    def point_component(self, map_id: str, component_id: str):
        with self.lock:
            frame = self._frame()
            if (self.phase != 'idle' or not self.state.get('armed') or frame is None
                    or self.state.get('moving') or self.state.get('driving')):
                raise ValueError('Enable movement and let it settle before pointing.')
            if self.component_map is None or self.component_map.map_id != map_id:
                raise ValueError('Choose a target from the current circuit map.')
            self.component_map.update(frame, self._context())
            component = self.component_map.component(component_id)
            if self.state.get('commissioning'):
                self._request('teaching', {'enabled':False})
            self.tracker = self.component_map.tracker(component_id)
            self.point = self.tracker.update(frame)
            self.point_sequence = frame['sequence']
            self._observe_spot(frame)
            self._start_job('pointing', lambda cancel:self._point_target(cancel, map_id, component_id))
            self.job_deadline = time.monotonic() + 120
            self.message = 'Pointing to ' + component['label']
            return self.status()

    def _point_target(self, cancel, map_id, component_id):
        with self.lock:
            self._check_job(cancel)
            if self.component_map is None or self.component_map.map_id != map_id:
                raise ValueError('The circuit map changed.')
            self.component_map.component(component_id)
            calibrated = self._calibration_valid()
        if not calibrated:
            self._calibrate(cancel)
        self._follow(cancel, recalibrate=True, timeout=90, observed_spot=True)

    def start_guidance(self, question: str):
        """One explicit local Start authorizes this bounded diagnose/point run."""
        question = question.strip()
        with self.lock:
            if not question or len(question) > 4000:
                raise ValueError('Describe what to check in up to 4000 characters.')
            if (self.phase != 'idle' or self.state.get('moving') or self.state.get('driving')
                    or self._frame() is None or time.monotonic() - self.presence > 0.9):
                raise ValueError('Connect the camera and stop the current movement before starting guidance.')
            if self.identifier is None:
                raise ValueError('The circuit reasoning connection is unavailable.')
            self._cancel()
            self._clear_map()
            self.tracker = self.point = None
            if not self.state.get('armed'):
                self._request('arm', {'clear':True, 'commissioning':False})
            elif self.state.get('commissioning'):
                self._request('teaching', {'enabled':False})
            self._start_job('guiding', lambda cancel:self._guide(cancel, question), target_required=False)
            self.job_deadline = time.monotonic() + 600
            self.guidance = {'state':'running', 'stage':'finding', 'question':question,
                             'message':'Finding the circuit in the Pi camera.', 'visited':[], 'index':0, 'total':0}
            self.message = self.guidance['message']
            return self.status()

    def _guide_stage(self, cancel, stage, message, **fields):
        with self.lock:
            self._check_session(cancel)
            self.guidance.update(stage=stage, message=message, **fields)
            self.message = message

    def _wait_view(self, cancel, timeout=4.0):
        """Wait for physical command completion and several fresh camera frames."""
        deadline = time.monotonic() + timeout
        sequences = set()
        while time.monotonic() < deadline:
            with self.lock:
                self._check_session(cancel)
                frame = self._frame()
                if self.state.get('moving'):
                    sequences.clear()
                else:
                    sequences.add(frame['sequence'])
                    if len(sequences) >= 5:
                        return frame
            cancel.wait(.08)
        raise ValueError('The camera or movement did not settle before the next observation.')

    def _refresh_guidance_camera(self, cancel):
        """Focus at the actual held pose after initial home, before registration."""
        with self.lock:
            self._check_session(cancel)
            if self.state.get('moving') or self.state.get('driving'):
                raise ValueError('Wait for the mechanism to stop before refocusing.')
            old = self.video
            pairing = old.pairing
            self._request('hold')
            self.refreshing_camera = True
            self.camera_refresh_token = cancel
            self.video = None
            self.tracker = self.point = self.calibration = self.aim_reference = None
            self._clear_map()
        replacement = None
        try:
            old.close()
            replacement = VideoLink(pairing)
            replacement.start()
            deadline = time.monotonic() + 12
            while replacement.frame() is None:
                with self.lock:
                    if cancel is not self.job_cancel or cancel.is_set() or not self.state.get('armed'):
                        raise ValueError('Camera refocus cancelled.')
                if replacement.error or time.monotonic() >= deadline:
                    raise ValueError(replacement.error or 'The camera did not refocus in time.')
                cancel.wait(.08)
            with self.lock:
                if cancel is not self.job_cancel or cancel.is_set() or not self.state.get('armed'):
                    raise ValueError('Camera refocus cancelled.')
                self.video = replacement
                replacement = None
                self.refreshing_camera = False
                self.camera_refresh_token = None
                self._check_session(cancel)
        finally:
            try:
                if replacement:
                    replacement.close()
            finally:
                with self.lock:
                    if self.camera_refresh_token is cancel:
                        self.refreshing_camera = False
                        self.camera_refresh_token = None

    def _search_positions(self):
        # Saved user-taught limits only. These are local survey positions, never model angles.
        values = {}
        for axis, margin in (('yaw', 25), ('pitch', 55)):
            limits = self.profile[axis]
            if limits['max'] - limits['min'] <= 2 * margin:
                raise ValueError('The saved travel range is too narrow to survey and calibrate.')
            values[axis] = (limits['min'] + margin, (limits['min'] + limits['max']) / 2,
                            limits['max'] - margin)
        current = self.state['commanded_us']
        positions = [{'yaw':yaw, 'pitch':pitch} for pitch in values['pitch'] for yaw in values['yaw']]
        positions.sort(key=lambda p:sum(((p[a]-current[a]) / (self.profile[a]['max']-self.profile[a]['min']))**2
                                       for a in ('yaw','pitch')))
        return positions

    def _survey_move(self, target, cancel):
        # Keep the Pi's <=100 us command contract; wait for each ramp to finish.
        with self.lock:
            self._check_session(cancel)
            self.calibration = None
        while True:
            with self.lock:
                self._check_session(cancel)
                current = self.state['commanded_us']
                delta = {a:target[a]-current[a] for a in ('yaw','pitch')}
                if max(abs(v) for v in delta.values()) < .5:
                    return
                scale = max(1., max(abs(v) for v in delta.values()) / 80.)
                self._request('move', {a:current[a]+delta[a]/scale for a in delta})
            self._wait_view(cancel)

    def _centre_region(self, cancel, frame, roi):
        with self.lock:
            self._check_session(cancel)
            self.framing_tracker = SceneFraming(frame, roi, margin=0.)
            self.framing = {'framing_id':str(uuid.uuid4()), 'state':'running',
                            'message':'Bringing the visible circuit into the centre of the camera.'}
            self.tracker = self.framing_tracker
            self.point = self.tracker.update(frame)
            self.point_sequence = frame['sequence']
            calibrated = self._calibration_valid()
        self._guide_stage(cancel, 'centring', 'Repositioning to see the circuit more clearly.')
        if not calibrated:
            self._calibrate(cancel)
        self._follow(cancel, recalibrate=True, timeout=90)
        with self.lock:
            self._check_job(cancel)
            self.framing.update(state='completed', message='Circuit area centred.')
            bounds = self.framing_tracker.summary()['bounds']
            left, top = max(0., bounds['x']), max(0., bounds['y'])
            return {'x':left, 'y':top, 'width':min(1.,bounds['x']+bounds['width'])-left,
                    'height':min(1.,bounds['y']+bounds['height'])-top}

    def _diagnose_view(self, cancel, question, roi):
        self._guide_stage(cancel, 'diagnosing', 'Inspecting the circuit and choosing areas to check.')
        with self.lock:
            self._check_session(cancel)
            self.tracker = self.point = None
            # Reasoning is stationary and does not alter camera geometry. Keep
            # the locally measured response; a new target gets fresh tracking.
            if self.component_map:
                self.component_map.close()
            self.component_map = DiagnosisMap(self._frame(), roi, self._context(), self.identifier, question)
            candidate = self.component_map
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            with self.lock:
                self._check_session(cancel)
                if self.component_map is not candidate:
                    raise ValueError('The circuit diagnosis was replaced.')
                candidate.update(self._frame(), self._context())
                self.guidance['answer'] = candidate.summary().get('answer')
                if candidate.phase == 'ready':
                    return candidate
                if candidate.phase == 'no_targets':
                    return None
                if candidate.phase in ('failed','lost','cancelled'):
                    raise ValueError(candidate.message)
            cancel.wait(.15)
        raise ValueError('Circuit reasoning timed out. Movement is stopped; retry when the connection is ready.')

    def _guide(self, cancel, question):
        frame = self._wait_view(cancel)
        self._guide_stage(cancel, 'focusing', 'Focusing the camera at the current held position.')
        self._refresh_guidance_camera(cancel)
        frame = self._wait_view(cancel)
        with self.lock:
            self._check_session(cancel)
            try:
                # Acquire an unambiguous real beam before board-edge reflections
                # appear during reframing. Later pointing still needs a current
                # candidate near this observation; this is never a fixed aim.
                self._observe_spot(frame)
            except ValueError:
                self.aim_reference = None
        roi = find_circuit_region(frame['image'])
        if roi:
            roi = self._centre_region(cancel, frame, roi)
        # First view is always considered, including non-rectangular circuits.
        candidate = None
        try:
            candidate = self._diagnose_view(cancel, question, {'x':0.,'y':0.,'width':1.,'height':1.})
        except ValueError as exc:
            # A blank initial view has no registerable scene; a network/model failure is not retried.
            if not any(text in str(exc) for text in ('too few distinctive', 'clustered or ambiguous')):
                raise
        if candidate is None:
            with self.lock:
                self._check_session(cancel)
                positions = self._search_positions()
                self._clear_map()
                self.tracker = self.point = None
            for index, position in enumerate(positions):
                self._guide_stage(cancel, 'finding', f'Looking for the circuit: view {index+1}/{len(positions)}.')
                self._survey_move(position, cancel)
                frame = self._wait_view(cancel)
                roi = find_circuit_region(frame['image'])
                if roi is None:
                    continue
                roi = self._centre_region(cancel, frame, roi)
                # The local blue/green board candidate may be only one module
                # of the circuit. Preserve visible connected wiring as context.
                candidate = self._diagnose_view(cancel, question, {'x':0.,'y':0.,'width':1.,'height':1.})
                if candidate is not None:
                    break
                with self.lock:
                    self._check_session(cancel)
                    self._clear_map()
                    self.tracker = self.point = None
            if candidate is None:
                raise ValueError('No circuit test areas were located within the saved travel range. Bring the board into view or mark it manually.')
        with self.lock:
            self._check_session(cancel)
            frame = self._frame()
            candidate.update(frame, self._context())
            roi = candidate.framing_region()
            candidate.reanchor(frame, self._context(), roi)
            ids = [item['id'] for item in candidate.components]
        # Reframe the actual diagnostic targets, rather than the whole background.
        self._centre_region(cancel, frame, roi)
        for index, ident in enumerate(ids):
            with self.lock:
                self._check_session(cancel)
                if self.component_map is not candidate:
                    raise ValueError('The diagnostic target map changed.')
                component = candidate.component(ident)
                frame = self._frame()
                self.tracker = candidate.tracker(ident)
                self.point = self.tracker.update(frame)
                self.point_sequence = frame['sequence']
                self._observe_spot(frame)
            self._guide_stage(cancel, 'pointing', f"Pointing to {index+1}/{len(ids)}: {component['label']}",
                              index=index+1, total=len(ids))
            self._point_target(cancel, candidate.map_id, ident)
            with self.lock:
                self._check_job(cancel)
                self.guidance['visited'].append(ident)
            cancel.wait(2.)
        self._guide_stage(cancel, 'completed', 'Diagnostic areas visited. Holding at the last test area.', state='completed')

    def _detect_spot(self, frame):
        seed = None
        seed_radius_px = None
        if (self.aim_reference and self.aim_reference.get('generation') == frame['generation']
                and self.aim_reference.get('orientation') == self.orientation):
            seed = (self.aim_reference['x'], self.aim_reference['y'])
            if self.aim_reference.get('source') == 'observed_red_spot':
                seed_radius_px = max(8., .01 * max(frame['image'].shape[:2]))
        return detect_red_spot(frame['image'], seed=seed, seed_radius_px=seed_radius_px)

    def _observe_spot(self, frame):
        observed = self._detect_spot(frame)
        self.aim_reference = {**observed, 'distance_mm':None, 'generation':frame['generation'],
                              'orientation':self.orientation, 'source':'observed_red_spot',
                              'sequence':frame['sequence'], 'physically_verified':False}
        return observed['x'], observed['y']

    def _tour(self, cancel, map_id, ids):
        with self.lock:
            self._check_job(cancel)
            self.tracker = SceneFraming.from_scene(self.component_map.scene, margin=0.0)
            frame = self._frame()
            self.point = self.tracker.update(frame)
            self.point_sequence = frame['sequence']
            self.tour['label'] = 'Centring circuit area'
            self.message = 'Centring the reviewed circuit area before visiting its components.'
            calibrated = self._calibration_valid()
        if not calibrated:
            self._calibrate(cancel)
        self._follow(cancel, (.5,.5), recalibrate=True, timeout=90)
        for index, ident in enumerate(ids):
            with self.lock:
                self._check_job(cancel)
                if self.component_map is None or self.component_map.map_id != map_id:
                    raise ValueError('The component map changed during the tour.')
                component = self.component_map.component(ident)
                frame = self._frame()
                self.tracker = self.component_map.tracker(ident)
                self.point = self.tracker.update(frame)
                self.point_sequence = frame['sequence']
                self.tour.update(index=index+1,label=component['label'])
                self.message = f"Visiting {index+1}/{len(ids)}: {component['label']}"
                reference = (self.aim_reference['x'],self.aim_reference['y'])
                observed_spot = self.aim_reference.get('source') != 'user_reference'
                calibrated = self._calibration_valid()
            if not calibrated:
                self._calibrate(cancel)
            self._follow(cancel, reference, recalibrate=True, observed_spot=observed_spot)
            with self.lock:
                self._check_job(cancel)
                self.tour['visited'].append(ident)
            cancel.wait(1.0)
        with self.lock:
            self._check_job(cancel)
            self.tour['state'] = 'completed'
            self.message = 'Component tour completed at the laser-reference marker. Physical beam accuracy remains unverified.'

    def _calibration_valid(self):
        return bool(self.calibration and self.calibration['context'] == self._context())

    def _check_session(self, cancel):
        if cancel is not self.job_cancel or cancel.is_set() or not self.state.get('armed') or time.monotonic() - self.presence > 0.9:
            raise ValueError('Movement cancelled or control released.')
        if self._frame() is None:
            raise ValueError('The camera view was lost.')
        if self.job_deadline is not None and time.monotonic() > self.job_deadline:
            raise ValueError('The automatic movement time limit was reached.')

    def _check_job(self, cancel):
        self._check_session(cancel)
        if self.point is None:
            raise ValueError('The selected feature was lost.')

    @property
    def observation_paused(self):
        return bool(self._observation_holds)

    def _settle(self, cancel, timeout=2.5):
        observation_token = object()
        with self.lock:
            self._observation_holds.add(observation_token)
        try:
            return self._settle_observed(cancel, timeout)
        finally:
            with self.lock:
                self._observation_holds.discard(observation_token)

    def _settle_observed(self, cancel, timeout):
        deadline = time.monotonic() + timeout
        with self.lock:
            context = self._context()
        while time.monotonic() < deadline:
            with self.lock:
                self._check_job(cancel)
                if context != self._context():
                    raise ValueError('Camera or travel settings changed during movement.')
                moving = self.state.get('moving')
            if not moving:
                break
            cancel.wait(0.03)
        else:
            raise ValueError('The movement did not settle in time.')
        # A servo can still be settling after the PWM ramp ends. Keep a rolling
        # window until stable, rather than rejecting its first four exposures.
        points, sequences = [], set()
        quiet_after = time.monotonic() + .25
        with self.lock:
            minimum_sequence = self._frame()['sequence']
        while time.monotonic() < deadline:
            with self.lock:
                self._check_job(cancel)
                frame = self._frame()
                if context != self._context():
                    raise ValueError('Camera or travel settings changed during movement.')
                captured = frame.get('received', time.monotonic()) - frame.get('age', 0.)
                if (time.monotonic() < quiet_after or captured < quiet_after
                        or frame['sequence'] <= minimum_sequence):
                    frame = None
                if frame is not None:
                    if self.component_map:
                        self.component_map.update(frame, context)
                        if self.component_map.phase == 'lost':
                            raise ValueError(self.component_map.message)
                    if self.framing_tracker and self.framing_tracker is not self.tracker:
                        self.framing_tracker.update(frame)
                    self.point = self.tracker.update(frame)
                    self.point_sequence = frame['sequence']
                    if self.aim_reference and self.aim_reference.get('source') == 'observed_red_spot':
                        try:
                            # Track gradual camera/beam parallax through settled
                            # framing steps. Pointing separately requires a
                            # current detection and never uses this as a fallback.
                            self._observe_spot(frame)
                        except ValueError:
                            pass
                if frame is not None and self.point_sequence not in sequences:
                    sequences.add(self.point_sequence)
                    points.append(self.point.copy())
                    points = points[-4:]
                    if len(points) == 4 and np.max(np.linalg.norm(np.array(points)-np.mean(points,axis=0),axis=1)) <= 3:
                        return np.mean(points[-3:], axis=0)
            cancel.wait(.07)
        raise ValueError('The selected feature did not settle. Check movement or choose another detail.')

    def _move(self, target, cancel):
        observation_token = object()
        with self.lock:
            self._check_job(cancel)
            context = self._context()
            self._observation_holds.add(observation_token)
        try:
            with self.lock:
                self._check_job(cancel)
                if context != self._context():
                    raise ValueError('Camera or travel settings changed during movement.')
                self._request('move', target)
                if context != self._context():
                    raise ValueError('Camera or travel settings changed during movement.')
                self.state['moving'] = True
            return self._settle(cancel)
        finally:
            with self.lock:
                self._observation_holds.discard(observation_token)

    def _start_job(self, name, procedure, *, target_required=True):
        with self.lock:
            if self.phase != 'idle' or not self.state.get('armed') or self.state.get('driving') or self.state.get('commissioning') or (target_required and self.point is None):
                raise ValueError('Enable ordinary control, select a feature, and finish the current action first.')
            self._cancel()
            self.job_cancel = threading.Event()
            cancel = self.job_cancel
            self.phase = name
            def work():
                try:
                    procedure(cancel)
                except Exception as exc:
                    with self.lock:
                        if cancel is self.job_cancel:
                            self.message = str(exc)[:300]
                            if self.tour and self.tour['state'] == 'running':
                                self.tour.update(state='stopped', reason=str(exc)[:300])
                            if self.framing and self.framing['state'] == 'running':
                                self.framing.update(state='stopped', message=str(exc)[:300])
                            if self.guidance and self.guidance['state'] == 'running':
                                self.guidance.update(state='stopped', message=str(exc)[:300], reason=str(exc)[:300])
                                if self.component_map and self.component_map.phase == 'identifying':
                                    self.component_map.close()
                            if self.control:
                                try:
                                    self._request('hold')
                                except Exception:
                                    pass
                finally:
                    with self.lock:
                        if cancel is self.job_cancel:
                            self.phase = 'idle'
            self.job_thread = threading.Thread(target=work, name='turret-' + name, daemon=True)
            self.job_thread.start()
            return self.status()

    def calibrate(self):
        return self._start_job('calibrating', self._calibrate)

    def _calibrate(self, cancel):
        with self.lock:
            self._check_job(cancel)
            base = dict(self.state['target_us'])
            profile = deepcopy(self.profile)
            context = self._context()
            pixel_scale = max(1., max(self._frame()['image'].shape[:2])/640.)
            self.calibration = None
            sweeps = {}
            for axis, extent in (('yaw', 20), ('pitch', 50)):
                lower, upper = profile[axis]['min'], profile[axis]['max']
                extent = min(extent, (upper-lower)/4)
                if extent < 4:
                    raise ValueError('The saved travel range has too little space for movement calibration here.')
                direction = 1 if upper-base[axis] >= 2*extent else -1
                start = base[axis]-direction*2*extent
                if direction > 0:
                    start = max(lower, min(upper-4*extent, start))
                else:
                    start = max(lower+4*extent, min(upper, start))
                sweeps[axis] = (start, direction*extent)
        # Gear play makes a repeated PWM setting an unreliable image origin.
        # Take up the reversal first, then measure consecutive movements in the
        # same direction. Finish at the observed pose instead of assuming home.
        samples = []
        target = dict(base)
        for index, axis in enumerate(('yaw', 'pitch')):
            start, step = sweeps[axis]
            target[axis] = start
            self._move(dict(target), cancel)
            target[axis] = start+step
            previous = self._move(dict(target), cancel)
            for multiple in (2, 3):
                target[axis] = start+multiple*step
                observed = self._move(dict(target), cancel)
                offset = np.zeros(2)
                offset[index] = step
                samples.append((offset, observed-previous))
                previous = observed
        # Validate at the sampled scale: half steps can fall inside a hobby
        # servo's deadband and falsely invalidate an otherwise measured slope.
        offset = np.array([sweeps['yaw'][1], sweeps['pitch'][1]])
        target = {axis: target[axis]+float(offset[i]) for i, axis in enumerate(('yaw', 'pitch'))}
        observed = self._move(target, cancel)
        result = fit_camera_map(samples, (offset, observed-previous), pixel_scale=pixel_scale)
        with self.lock:
            self._check_job(cancel)
            if context != self._context():
                raise ValueError('Camera or travel settings changed during calibration.')
            self.calibration = {**result, 'context': context, 'origin_us': target,
                                'sampling_method': 'consecutive_after_preload',
                                'calibration_revision': str(uuid.uuid4()), 'evidence_kind': 'camera_observation'}
            self.message = ('Movement calibrated. Continuing automatic guidance.' if self.phase == 'guiding'
                            else 'Camera movement calibrated locally. Select a feature and choose Follow point.')

    def follow(self, aim: bool = False):
        with self.lock:
            if not self._calibration_valid():
                raise ValueError('Calibrate camera movement before following a point.')
            if aim and self.aim_reference is None:
                raise ValueError('Set an aiming reference and working distance first.')
            reference = (self.aim_reference['x'], self.aim_reference['y']) if aim else (0.5, 0.5)
        return self._start_job('aiming rehearsal' if aim else 'following', lambda cancel: self._follow(cancel, reference))

    def _follow(self, cancel, reference=(0.5, 0.5), *, recalibrate=False, timeout=30, observed_spot=False):
        deadline = time.monotonic() + timeout
        stable = 0
        previous_error = None
        worsening = 0
        aligned_sequences = set()
        while time.monotonic() < deadline:
            with self.lock:
                self._check_job(cancel)
                if not self._calibration_valid():
                    raise ValueError('The camera calibration is no longer current.')
                mapping = deepcopy(self.calibration)
                frame = self._frame()
                # Compare feature and spot from the same exposure, not the
                # slower supervisor's preceding observation.
                if self.tracker is not None:
                    self.point = self.tracker.update(frame)
                    self.point_sequence = frame['sequence']
                if observed_spot:
                    reference = self._observe_spot(frame)
                point = self.point.copy()
                observed_sequence = self.point_sequence
                height, width = frame['image'].shape[:2]
                current = dict(self.state['commanded_us'])
                target, aligned = correction(mapping, point, (width, height), current, self.profile, reference)
                refresh_map = any(abs(target[axis] - mapping['origin_us'][axis]) > radius
                                  for axis, radius in (('yaw', 60), ('pitch', 150)))
                if refresh_map and not recalibrate:
                    raise ValueError('The point left the locally calibrated area. Move manually and recalibrate there.')
                error = float(np.linalg.norm(point - np.array([(width - 1) * reference[0], (height - 1) * reference[1]])))
            if refresh_map:
                self._calibrate(cancel)
                previous_error = None
                worsening = 0
                continue
            if aligned:
                aligned_sequences.add(observed_sequence)
                stable = len(aligned_sequences)
                if stable >= 3:
                    with self.lock:
                        self._check_job(cancel)
                        self.message = 'The selected feature is aligned with the reference. Holding position; laser accuracy is unverified.'
                    return
                cancel.wait(0.15)
                continue
            stable = 0
            aligned_sequences.clear()
            if previous_error is not None and error > previous_error + 3:
                worsening += 1
            else:
                worsening = 0
            if worsening >= 2:
                raise ValueError('Tracking is not converging. Recalibrate before trying again.')
            previous_error = error
            observed = self._move(target, cancel)
            if recalibrate:
                advanced = advance_camera_map(mapping, point, observed, current, target)
                if advanced is not None:
                    with self.lock:
                        self._check_job(cancel)
                        if (self.calibration is not None and self._context() == mapping['context']
                                and self.calibration['calibration_revision'] == mapping['calibration_revision']):
                            self.calibration = advanced
        raise ValueError('Point following timed out; movement stopped.')

    def disconnect(self):
        with self.lock:
            self.connection_generation += 1
            self._cancel()
            self.stop_event.set()
            control, video = self.control, self.video
            self.control = self.video = None
            self.state = {}
            self.tracker = None
            self.point = None
            self.calibration = None
            self.aim_reference = None
            self._clear_map()
            self.message = 'Disconnected. Movement remains disabled until explicitly enabled again.'
        if control:
            try:
                control.request('release')
            except Exception:
                pass
            control.close()
        if video:
            video.close()
        return self.status()

    def close(self):
        self.disconnect()
