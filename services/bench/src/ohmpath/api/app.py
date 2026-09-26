from __future__ import annotations

import asyncio
import json
import secrets
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ohmpath import __version__
from ohmpath.circuits import load_fixture, run_operating_point
from ohmpath.contracts import Revisions
from ohmpath.session.measurements import Measurements, cancel_pending
from ohmpath.session.store import DomainError, SessionStore, opaque_id


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NewSession(Input):
    name: str = Field(default="Practice bench", min_length=1, max_length=100)


class Setup(Input):
    power_state: Literal["off_verified", "on_current_limited", "unknown"]
    setup: dict[str, bool | str] = Field(default_factory=dict)


class TestRequest(Input):
    quantity: Literal["voltage", "resistance", "continuity"]
    meter_mode: Literal["DC_voltage", "AC_voltage", "resistance", "continuity"]
    red_node_id: str = Field(min_length=1, max_length=64)
    black_node_id: str = Field(min_length=1, max_length=64)
    meter_range: str = Field(default="auto", min_length=1, max_length=64)
    instrument_id: str = Field(default="manual-meter", min_length=1, max_length=64)
    target_ids: list[str] = Field(default_factory=list, max_length=16)


class CandidateInput(Input):
    text: str = Field(min_length=1, max_length=4096)
    request_id: str = Field(min_length=1, max_length=64)


class ReadbackInput(Input):
    confirmation_id: str = Field(min_length=1, max_length=64)


class ConfirmInput(Input):
    confirmation_id: str
    candidate_id: str
    request_id: str
    measurement_context_hash: str
    revisions: Revisions
    supersedes_event_id: str | None = None


class FixtureInput(Input):
    name: Literal["divider", "loaded-divider"]


class ModelSimulation(Input):
    circuit_revision: str
    variant_id: Literal["healthy"]


class ModelProposal(TestRequest):
    circuit_revision: str
    reason: str = Field(min_length=1, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=16)


def create_app(data_dir: Path, user_token: str, model_token: str | None = None) -> FastAPI:
    if len(user_token) < 32 or (model_token is not None and (len(model_token) < 32 or model_token == user_token)):
        raise ValueError("Distinct ephemeral capabilities of at least 32 characters are required")
    store = SessionStore(data_dir / "bench.sqlite3")
    measurements = Measurements(store)
    simulation_slots = threading.BoundedSemaphore(2)

    @asynccontextmanager
    async def lifespan(app):
        yield
        store.close()

    app = FastAPI(title="Ohm Path", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.store = store

    def role(authorization: str = Header(default="")):
        if authorization.startswith("Bearer "):
            token = authorization[7:]
            if secrets.compare_digest(token, user_token):
                return "user"
            if model_token is not None and secrets.compare_digest(token, model_token):
                return "model"
        raise DomainError("unauthorized", "This application connection has expired.", 401)

    def user_scope(actor=Depends(role)):
        if actor != "user":
            raise DomainError("capability_denied", "Only the local user can change or confirm bench state.", 403)
        return actor

    def model_scope(actor=Depends(role)):
        if actor != "model":
            raise DomainError("capability_denied", "This endpoint requires the model-only capability.", 403)

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": error.code, "message": error.message})

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        host = request.headers.get("host", "").split(":")[0]
        origin = request.headers.get("origin")
        if host not in ("127.0.0.1", "localhost", "testserver") or origin not in (None, "http://127.0.0.1:5173"):
            return JSONResponse(status_code=403, content={"error": "origin_denied", "message": "Local application access only."})
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 65536:
                return JSONResponse(status_code=413, content={"error": "request_too_large"})
        request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/v1/health", dependencies=[Depends(role)])
    def health():
        return {"name": "Ohm Path", "version": __version__, "status": "ready", "hardware": "disabled",
                "reasoning": "blocked_pending_permission_proof", "voice": "not_connected"}

    @app.get("/v1/sessions", dependencies=[Depends(role)])
    def sessions():
        return store.list_sessions()

    @app.post("/v1/sessions", dependencies=[Depends(user_scope)])
    def create(body: NewSession):
        state = store.create(body.name)
        select_fixture(state["session_id"], FixtureInput(name="divider"))
        return store.get(state["session_id"])

    @app.get("/v1/sessions/{sid}", dependencies=[Depends(role)])
    def session(sid: str):
        return store.get(sid)

    @app.get("/v1/sessions/{sid}/events", dependencies=[Depends(role)])
    def events(sid: str, after: int = Query(default=0, ge=0)):
        return store.events(sid, after)

    @app.post("/v1/sessions/{sid}/setup", dependencies=[Depends(user_scope)])
    def setup(sid: str, body: Setup):
        return measurements.setup(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/requests", dependencies=[Depends(user_scope)])
    def request_measurement(sid: str, body: TestRequest):
        return measurements.request(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/candidates", dependencies=[Depends(user_scope)])
    def candidate(sid: str, body: CandidateInput):
        return measurements.typed_candidate(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/readback", dependencies=[Depends(user_scope)])
    def readback(sid: str, body: ReadbackInput):
        return measurements.readback(sid, body.confirmation_id)

    @app.post("/v1/sessions/{sid}/confirm", dependencies=[Depends(user_scope)])
    def confirm(sid: str, body: ConfirmInput):
        return measurements.confirm(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/pause", dependencies=[Depends(user_scope)])
    def pause(sid: str):
        def update(state, emit):
            cancel_pending(state)
            state.update(status="paused", hardware_state="disarmed", arming_epoch=opaque_id())
            emit("session.paused", {"reason": "Local stop"})
        return store.transact(sid, update)

    @app.post("/v1/sessions/{sid}/fixture", dependencies=[Depends(user_scope)])
    def select_fixture(sid: str, body: FixtureInput):
        graph = load_fixture(body.name)
        def update(state, emit):
            cancel_pending(state)
            state.update(fixture=body.name, power_state="unknown", setup={}, status="active")
            state["revisions"]["circuit_revision"] = opaque_id()
            state["revisions"]["calibration_revision"] = None
            state["known_nodes"] = sorted({n for c in graph.components for n in c.nodes})
            emit("circuit.selected", {"fixture": body.name, "graph": graph.model_dump(mode="json")})
        return store.transact(sid, update)

    @app.get("/v1/sessions/{sid}/graph", dependencies=[Depends(role)])
    def graph(sid: str):
        state = store.get(sid)
        return {"graph": load_fixture(state["fixture"]).model_dump(mode="json"), "revisions": state["revisions"]}

    @app.post("/v1/sessions/{sid}/simulate", dependencies=[Depends(user_scope)])
    def simulate(sid: str):
        state = store.get(sid)
        if not simulation_slots.acquire(blocking=False):
            raise DomainError("simulation_busy", "Wait for the current local simulation to finish.", 429)
        try:
            result = run_operating_point(load_fixture(state["fixture"]), work_root=data_dir / "simulations")
        finally:
            simulation_slots.release()
        def record(current, emit):
            if current["revisions"] != state["revisions"]:
                raise DomainError("simulation_context_changed", "Circuit changed; discard this obsolete simulation.")
            return emit("simulation.finished", result.model_dump(mode="json"))
        return store.transact(sid, record)

    @app.post("/v1/model/sessions/{sid}/simulate", dependencies=[Depends(model_scope)])
    def model_simulate(sid: str, body: ModelSimulation):
        state = store.get(sid)
        if state["revisions"]["circuit_revision"] != body.circuit_revision:
            raise DomainError("simulation_context_changed", "The circuit revision has changed.")
        event = simulate(sid)
        result = event["payload"]
        return {"session_id": sid, "circuit_revision": body.circuit_revision, "variant_id": body.variant_id,
                "status": "completed" if result["status"] == "succeeded" else "failed",
                "simulation_id": result["simulation_id"], "input_hash": result["netlist_sha256"],
                "evidence_ids": [event["event_id"]], "result": result}

    @app.post("/v1/model/sessions/{sid}/proposals", dependencies=[Depends(model_scope)])
    def propose(sid: str, body: ModelProposal):
        def record(state, emit):
            if state["revisions"]["circuit_revision"] != body.circuit_revision:
                raise DomainError("proposal_context_changed", "The circuit revision has changed.")
            if body.red_node_id == body.black_node_id or any(
                n not in state.get("known_nodes", []) for n in (body.red_node_id, body.black_node_id)
            ):
                raise DomainError("proposal_invalid", "The probe endpoints must be distinct accepted nodes.")
            expected_modes = {"voltage": ("DC_voltage", "AC_voltage"), "resistance": ("resistance",), "continuity": ("continuity",)}
            if body.meter_mode not in expected_modes[body.quantity]:
                raise DomainError("proposal_invalid", "The proposed quantity and meter mode disagree.")
            for evidence_id in body.evidence_ids:
                row = store.db.execute("SELECT body FROM events WHERE event_id=? AND session_id=?",
                                       (evidence_id, sid)).fetchone()
                if not row or json.loads(row[0])["circuit_revision"] != body.circuit_revision:
                    raise DomainError("proposal_evidence_invalid", "Proposal cites missing or obsolete evidence.")
            event = emit("diagnostic.proposed", body.model_dump(), source="model")
            return {"session_id": sid, "circuit_revision": body.circuit_revision,
                    "proposal_id": event["event_id"], "evidence_ids": body.evidence_ids, "status": "proposed"}
        return store.transact(sid, record)

    @app.websocket("/v1/sessions/{sid}/events")
    async def event_stream(socket: WebSocket, sid: str):
        host = socket.headers.get("host", "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "testserver") or socket.headers.get("origin") not in (None, "http://127.0.0.1:5173"):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            auth_text = await asyncio.wait_for(socket.receive_text(), timeout=3)
            if len(auth_text) > 1024:
                await socket.close(code=1009)
                return
            auth = json.loads(auth_text)
            if not isinstance(auth, dict) or not isinstance(auth.get("token"), str) or not secrets.compare_digest(auth["token"], user_token):
                await socket.close(code=1008)
                return
            after = auth.get("after", 0)
            if type(after) is not int or after < 0:
                await socket.close(code=1008)
                return
            store.get(sid)
            while True:
                batch = store.events(sid, after, 100)
                if batch:
                    await asyncio.wait_for(socket.send_json(batch), timeout=3)
                    after = batch[-1]["sequence"]
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, DomainError):
            pass

    return app
