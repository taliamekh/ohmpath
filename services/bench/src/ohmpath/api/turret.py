"""Physical movement routes, available only to the local user capability."""
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Arm(Input):
    clear: bool = True
    laser_disconnected: bool | None = None  # Legacy clients; externally powered, not sensed.
    commissioning: bool = False


class Jog(Input):
    axis: Literal['yaw', 'pitch']
    direction: Literal[-1, 1]
    fine: bool = False


class Drive(Input):
    yaw: int = Field(ge=-1, le=1)
    pitch: int = Field(ge=-1, le=1)
    fine: bool = False
    session: str = Field(min_length=10, max_length=80)
    sequence: int = Field(ge=0, le=2_147_483_647)


class Save(Input):
    what: Literal['home', 'min', 'max']
    axis: Literal['yaw', 'pitch'] | None = None


class Teaching(Input):
    enabled: bool


class Point(Input):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)
    sequence: int = Field(ge=1)
    generation: str = Field(min_length=10, max_length=80)


class AimReference(Point):
    distance_mm: int = Field(ge=50, le=3000)


class Follow(Input):
    aim: bool = False


class CameraView(Input):
    sequence: int = Field(ge=1)
    generation: str = Field(min_length=10, max_length=80)


class Region(Input):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)
    width: float = Field(ge=0.05, le=1, allow_inf_nan=False)
    height: float = Field(ge=0.05, le=1, allow_inf_nan=False)


class Identify(CameraView):
    roi: Region


class MapChoice(Input):
    map_id: str = Field(min_length=36, max_length=36)


class FramingChoice(Input):
    framing_id: str = Field(min_length=36, max_length=36)


class Guidance(Input):
    question: str = Field(min_length=1, max_length=4000)


class ComponentChoice(MapChoice):
    component_id: str = Field(min_length=36, max_length=36)


class SpotReference(CameraView):
    x: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)


def router(turret, user_scope):
    routes = APIRouter(prefix='/v1/turret', dependencies=[Depends(user_scope)])

    def invoke(function, **kwargs):
        try:
            return function(**kwargs)
        except (ValueError, RuntimeError, OSError) as exc:
            return JSONResponse(status_code=409, content={'error': 'turret_unavailable', 'message': str(exc)[:400]})

    @routes.get('/status')
    def status():
        return turret.status()

    @routes.get('/frame')
    def frame():
        return invoke(turret.frame)

    # Each no-argument action still rejects unexpected data.
    def simple(function):
        def action(body: Input):
            return invoke(function)
        return action

    for name, function in (
        ('connect', turret.connect), ('disconnect', turret.disconnect), ('keepalive', turret.keepalive),
        ('release', turret.release), ('stop', turret.stop_follow), ('home', turret.home),
        ('rotate', turret.rotate), ('refocus', turret.refocus), ('calibrate', turret.calibrate),
        ('clear-components', turret.clear_components),
    ):
        routes.add_api_route('/' + name, simple(function), methods=['POST'], name='turret_' + name)

    @routes.post('/arm')
    def arm(body: Arm):
        return invoke(turret.arm, **body.model_dump())

    @routes.post('/jog')
    def jog(body: Jog):
        return invoke(turret.jog, **body.model_dump())

    @routes.post('/drive')
    def drive(body: Drive):
        return invoke(turret.drive, **body.model_dump())

    @routes.post('/save')
    def save(body: Save):
        return invoke(turret.save_position, **body.model_dump())

    @routes.post('/teaching')
    def teaching(body: Teaching):
        return invoke(turret.teaching, **body.model_dump())

    @routes.post('/select')
    def select(body: Point):
        return invoke(turret.select, **body.model_dump())

    @routes.post('/aim-reference')
    def reference(body: AimReference):
        return invoke(turret.set_aim_reference, **body.model_dump())

    @routes.post('/follow')
    def follow(body: Follow):
        return invoke(turret.follow, **body.model_dump())

    @routes.post('/identify-components')
    def identify_components(body: Identify | FramingChoice):
        return invoke(turret.identify_components, **body.model_dump())

    @routes.post('/approve-components')
    def approve_components(body: MapChoice):
        return invoke(turret.approve_components, **body.model_dump())

    @routes.post('/tour')
    def tour(body: MapChoice):
        return invoke(turret.start_tour, **body.model_dump())

    @routes.post('/spot-reference')
    def spot_reference(body: SpotReference):
        return invoke(turret.spot_reference, **body.model_dump())

    @routes.post('/prepare-framing')
    def prepare_framing(body: Identify):
        return invoke(turret.prepare_framing, **body.model_dump())

    @routes.post('/reposition')
    def reposition(body: FramingChoice):
        return invoke(turret.reposition, **body.model_dump())

    @routes.post('/guide')
    def guide(body: Guidance):
        return invoke(turret.start_guidance, **body.model_dump())

    @routes.post('/point-component')
    def point_component(body: ComponentChoice):
        return invoke(turret.point_component, **body.model_dump())

    return routes
