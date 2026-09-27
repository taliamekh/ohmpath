"""Identified component candidates, explicitly accepted and locally registered.

Model annotations are labels on a frozen crop. They never become pulse commands.
Only a current, user-accepted map can resolve component IDs through local vision.
"""
from __future__ import annotations

import base64
import math
import uuid

import cv2

from .turret_scene import RegisteredScene


IDENTIFY_PROMPT = (
    'Identify up to eight distinct visible electronic components or clearly labeled board modules in this circuit crop. '
    'Return one annotation per identifiable component, at the centre of its visible body or a distinctive printed detail, '
    'with a short specific label and unique numbering for repeated parts. Prefer textured body details suitable for visual tracking. '
    'Only annotate what is actually visible; omit guessed parts, hidden terminals, reflections, people, and laser spots. '
    'Order annotations naturally from top to bottom, left to right. Explain uncertainty briefly. '
    'These are visual identification candidates for an onscreen map, not verified electrical facts or actuator instructions. '
    'Do not infer measured values, circuit correctness, servo directions, or permission to move hardware.'
)


class ComponentIdentifier:
    """Share the application's existing image-only subscription admission gate."""
    def __init__(self, photo_help, investigations, admission):
        self.photo_help, self.investigations, self.admission = photo_help, investigations, admission

    def start(self, context, image_id, jpeg):
        return self._submit(context, image_id, jpeg, IDENTIFY_PROMPT)

    def start_diagnosis(self, context, image_id, jpeg, question):
        from .turret_guidance import diagnosis_prompt
        return self._submit(context, image_id, jpeg, diagnosis_prompt(question))

    def _submit(self, context, image_id, jpeg, prompt):
        with self.admission:
            with self.investigations.lock:
                if any(job['worker'].is_alive() for job in self.investigations.jobs.values()):
                    raise ValueError('Wait for the current circuit investigation before identifying components.')
            return self.photo_help.start(context, prompt, [{'image_id': image_id,
                'mime_type':'image/jpeg', 'image_base64':base64.b64encode(jpeg).decode()}])

    def status(self, turn_id):
        return self.photo_help.status(turn_id)

    def cancel(self, context):
        return self.photo_help.cancel(context)


class ComponentMap:
    def __init__(self, frame, roi, context, identifier):
        if identifier is None:
            raise ValueError('Component identification is unavailable in this app instance.')
        self.scene = self._make_scene(frame, roi)
        self.context = context
        self.identifier = identifier
        self.map_id = str(uuid.uuid4())
        self.image_id = str(uuid.uuid4())
        self.generation = frame['generation']
        self.source_sequence = frame['sequence']
        self.roi = dict(roi)
        self.height, self.width = frame['image'].shape[:2]
        # Keep every submitted pixel inside the selected normalized region.
        x0, y0 = math.ceil(roi['x'] * (self.width-1)), math.ceil(roi['y'] * (self.height-1))
        x1 = min(self.width, math.floor((roi['x']+roi['width']) * (self.width-1))+1)
        y1 = min(self.height, math.floor((roi['y']+roi['height']) * (self.height-1))+1)
        self.crop = (x0,y0,x1,y1)
        ok, encoded = cv2.imencode('.jpg', frame['image'][y0:y1,x0:x1], [cv2.IMWRITE_JPEG_QUALITY,95])
        if not ok or len(encoded) > 2_000_000:
            raise ValueError('Choose a smaller, clear circuit area.')
        self.phase = 'identifying'
        self.message = 'Identifying components in your selected circuit area…'
        self.components = []
        self.approved = False
        self.turn_id = None
        result = self._start_request(encoded.tobytes())
        self.turn_id = result['turn_id']

    def _make_scene(self, frame, roi):
        return RegisteredScene(frame, roi)

    def _start_request(self, jpeg):
        return self.identifier.start(self.map_id, self.image_id, jpeg)

    def _accept_answer(self, answer):
        self._accept_candidates(answer['annotations'])

    def close(self):
        if self.turn_id:
            self.identifier.cancel(self.map_id)
        self.approved = False
        self.phase = 'cancelled'

    def lose(self, message):
        self.approved = False
        self.phase = 'lost'
        self.message = message
        if self.turn_id:
            self.identifier.cancel(self.map_id)

    def update(self, frame, context):
        if self.phase in ('lost','cancelled','failed'):
            return
        try:
            if context != self.context:
                raise ValueError('Camera or travel settings changed. Identify the circuit again.')
            self.scene.update(frame)
            if self.phase == 'identifying':
                result = self.identifier.status(self.turn_id)
                if result['status'] == 'completed':
                    self._accept_answer(result['answer'])
                elif result['status'] != 'running':
                    self.phase = 'failed'
                    self.message = result.get('message', 'Identification was cancelled. Try again.')
        except ValueError as error:
            self.lose(str(error))

    def _accept_candidates(self, annotations):
        x0,y0,x1,y1 = self.crop
        candidates = []
        for item in annotations[:8]:
            if item['image_id'] != self.image_id:
                raise ValueError('Identification refers to an old camera snapshot.')
            if any(type(item[k]) not in (int,float) or not math.isfinite(item[k]) or not 0 <= item[k] <= 1 for k in ('x','y')):
                raise ValueError('Identification returned invalid component positions.')
            x = (x0 + item['x']*(x1-x0-1))/(self.width-1)
            y = (y0 + item['y']*(y1-y0-1))/(self.height-1)
            self.scene.resolve(x,y)
            candidates.append({'id':str(uuid.uuid4()),'label':item['label'],'x':x,'y':y})
        self.components = candidates
        self.phase = 'review' if candidates else 'failed'
        self.message = ('Review the numbered component markers, then accept the map.' if candidates
                        else 'No clear components were identified. Choose a closer circuit area.')

    def approve(self, map_id, frame, context):
        self.update(frame, context)
        if map_id != self.map_id or self.phase != 'review':
            raise ValueError('That component map is no longer ready for review.')
        # A visual appearance check is required in addition to a model-supplied label.
        for component in self.components:
            self.scene.verify_point(component['x'], component['y'])
        self.approved = True
        self.phase = 'ready'
        self.message = 'Component map accepted. Select the laser reference, then start the tour.'

    def component(self, component_id):
        if not self.approved or self.phase != 'ready':
            raise ValueError('Review and accept a current component map first.')
        for component in self.components:
            if component['id'] == component_id:
                return dict(component)
        raise ValueError('The selected component is absent from the current map.')

    def tracker(self, component_id):
        component = self.component(component_id)
        return ScenePoint(self, component)

    def summary(self):
        components = []
        for index, component in enumerate(self.components):
            point = None
            if self.phase in ('review','ready'):
                try:
                    pixel = self.scene.resolve(component['x'],component['y'])
                    point = {'x':float(pixel[0]/(self.width-1)), 'y':float(pixel[1]/(self.height-1))}
                except ValueError:
                    pass
            components.append({'id':component['id'],'label':component['label'],'number':index+1,'point':point})
        return {'map_id':self.map_id,'phase':self.phase,'approved':self.approved,
                'message':self.message,'components':components,'roi':self.roi,
                'evidence_kind':'visual_candidates_accepted_by_user' if self.approved else 'visual_candidates'}


class ScenePoint:
    def __init__(self, component_map, component):
        self.component_map, self.component = component_map, component

    def update(self, frame):
        if not self.component_map.approved:
            raise ValueError('The component map is no longer approved.')
        self.component_map.scene.update(frame)
        return self.component_map.scene.verify_point(self.component['x'], self.component['y'])
