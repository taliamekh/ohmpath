from __future__ import annotations

import asyncio
import base64
import binascii
import json
import secrets
import hashlib
import threading
from dataclasses import asdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ohmpath import __version__
from ohmpath.ai.investigations import Investigations
from ohmpath.ai.photo_help import PhotoHelp
from ohmpath.circuits import load_fixture, run_operating_point
from ohmpath.circuits.models import CircuitGraph
from ohmpath.circuits.assembly import logical_assembly_guide
from ohmpath.contracts import Revisions
from ohmpath.devices.firmware import parse_firmware_evidence
from ohmpath.session.measurements import Measurements, cancel_pending, context_hash
from ohmpath.session.store import DomainError, SessionStore, opaque_id, utc_now
from ohmpath.session.reporting import session_report
from ohmpath.voice.parsing import parse_reading, route_utterance
from ohmpath.voice.transcription import WhisperWorker


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NewSession(Input):
    name: str = Field(default="Practice bench", min_length=1, max_length=100)
    mode: Literal["mock", "supervised"] = "mock"


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


class MeterCropInput(Input):
    image_base64: str = Field(min_length=1, max_length=2_700_000)
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


class QuestionInput(Input):
    text: str = Field(min_length=1, max_length=4096)


class VoiceInput(Input):
    text: str = Field(default="", max_length=4096)
    utterance_id: str = Field(min_length=1, max_length=80)
    request_id: str | None = None
    confirmation_id: str | None = None
    final: bool = True
    own_speech: bool = False


class AudioInput(VoiceInput):
    wav_base64: str = Field(min_length=1, max_length=2_000_000)


class PhotoAudioInput(Input):
    wav_base64: str = Field(min_length=1, max_length=2_000_000)


class AimInput(Input):
    target_x: float = Field(ge=0, le=640, allow_inf_nan=False)
    target_y: float = Field(ge=0, le=480, allow_inf_nan=False)


class InvestigationInput(Input):
    question: str = Field(min_length=1, max_length=4000)


class ImageInvestigationInput(InvestigationInput):
    image_base64: str = Field(min_length=1, max_length=2_700_000)


class TurnInput(Input):
    turn_id: str = Field(min_length=1, max_length=64)


class PhotoImageInput(Input):
    image_id: str = Field(min_length=36, max_length=36)
    mime_type: Literal["image/png", "image/jpeg"]
    image_base64: str = Field(min_length=1, max_length=2_700_000)


class PhotoHelpInput(Input):
    context_id: str = Field(min_length=36, max_length=36)
    question: str = Field(min_length=1, max_length=4000)
    images: list[PhotoImageInput] = Field(min_length=1, max_length=3)


class PhotoCancelInput(Input):
    context_id: str = Field(min_length=36, max_length=36)
    turn_id: str | None = Field(default=None, min_length=36, max_length=36)


class FirmwareInput(Input):
    log_text: str = Field(min_length=1, max_length=40000)
    board: str | None = Field(default=None, max_length=80)
    baud_rate: int | None = Field(default=None, ge=300, le=4000000)


class SchematicInput(Input):
    schematic_base64: str = Field(min_length=1, max_length=6_700_000)


class ImportInput(Input):
    import_id: str = Field(min_length=1, max_length=64)


class LaboratoryInput(Input):
    template: Literal["rc", "diode"]
    resistance_ohm: float = Field(default=1000.0, ge=100, le=1_000_000, allow_inf_nan=False)
    capacitance_f: float = Field(default=1e-6, ge=1e-9, le=1e-3, allow_inf_nan=False)
    supply_v: float = Field(default=3.3, ge=0.1, le=5.0, allow_inf_nan=False)


class CalibrationSampleInput(Input):
    yaw_deg: float = Field(ge=-45, le=45, allow_inf_nan=False)
    pitch_deg: float = Field(ge=-45, le=45, allow_inf_nan=False)
    dx_px: float = Field(ge=-10000, le=10000, allow_inf_nan=False)
    dy_px: float = Field(ge=-10000, le=10000, allow_inf_nan=False)


class CalibrationFitInput(Input):
    circuit_revision: str = Field(min_length=1, max_length=64)
    data_source: Literal["user_supplied", "synthetic"]
    fit_samples: list[CalibrationSampleInput] = Field(max_length=100)
    validation_samples: list[CalibrationSampleInput] = Field(max_length=100)


def create_app(data_dir: Path, user_token: str, model_token: str | None = None) -> FastAPI:
    if len(user_token) < 32 or (model_token is not None and (len(model_token) < 32 or model_token == user_token)):
        raise ValueError("Distinct ephemeral capabilities of at least 32 characters are required")
    store = SessionStore(data_dir / "bench.sqlite3")
    measurements = Measurements(store)
    speech = WhisperWorker()
    investigations = Investigations(store, model_token)
    photo_help = PhotoHelp()
    investigation_admission = threading.RLock()
    simulation_slots = threading.BoundedSemaphore(2)

    def accepted_graph(state):
        if state.get("imported_graph") is not None:
            return CircuitGraph.model_validate_json(json.dumps(state["imported_graph"]))
        return load_fixture(state["fixture"])

    def current_readings(state):
        return [e for e in store.current_measurements(state["session_id"], state["revisions"]["circuit_revision"])
                if e["payload"]["request"]["measurement_context_hash"] == context_hash(state, e["payload"]["request"])]

    @asynccontextmanager
    async def lifespan(app):
        yield
        investigations.close()
        photo_help.close()
        speech.close()
        store.close()

    app = FastAPI(title="Ohm Path", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.store = store
    app.state.investigations = investigations
    app.state.photo_help = photo_help

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
            cap = 8_200_000 if request.url.path == "/v1/photo-help/investigate" else 6_800_000 if request.url.path.endswith("/imports") else 2_800_000 if request.url.path.endswith(("/candidates/ocr", "/investigate/image")) else 2_100_000 if request.url.path.endswith(("/voice/transcribe", "/voice/transcribe-question")) else 65536
            if len(body) > cap:
                return JSONResponse(status_code=413, content={"error": "request_too_large"})
        request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/v1/health", dependencies=[Depends(role)])
    def health():
        return {"name": "Ohm Path", "version": __version__, "status": "ready", "hardware": "disabled",
                "reasoning": "subscription_on_request" if investigations.base_url else "unavailable",
                "voice": speech.status()["status"]}

    @app.get("/v1/sessions", dependencies=[Depends(role)])
    def sessions():
        return store.list_sessions()

    @app.post("/v1/sessions", dependencies=[Depends(user_scope)])
    def create(body: NewSession):
        state = store.create(body.name, body.mode)
        select_fixture(state["session_id"], FixtureInput(name="divider"))
        return store.get(state["session_id"])

    @app.get("/v1/sessions/{sid}", dependencies=[Depends(role)])
    def session(sid: str):
        return store.get(sid)

    @app.get("/v1/sessions/{sid}/report", dependencies=[Depends(user_scope)])
    def report(sid: str):
        return {"markdown": session_report(store, sid), "privacy": "local_summary_only"}

    @app.get("/v1/sessions/{sid}/events", dependencies=[Depends(role)])
    def events(sid: str, after: int = Query(default=0, ge=0), tail: bool = False):
        return store.recent_events(sid, 100) if tail else store.events(sid, after)

    @app.get("/v1/sessions/{sid}/evidence", dependencies=[Depends(role)])
    def evidence(sid: str):
        state = store.get(sid)
        revision = state["revisions"]["circuit_revision"]
        rows = current_readings(state)[-8:]
        graph_id = store.circuit_evidence(sid, revision)
        compact = [{"event_id": row["event_id"], "event_type": row["event_type"], "circuit_revision": revision,
                    "payload": row["payload"]} for row in rows]
        while compact and len(json.dumps(compact).encode()) > 24000:
            compact.pop(0)
        return {"session_id": sid, "circuit_revision": revision, "events": compact,
                "evidence_ids": ([graph_id] if graph_id else []) + [row["event_id"] for row in compact],
                "mode": state["mode"], "physical_verification": "pending"}

    @app.post("/v1/sessions/{sid}/setup", dependencies=[Depends(user_scope)])
    def setup(sid: str, body: Setup):
        return measurements.setup(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/requests", dependencies=[Depends(user_scope)])
    def request_measurement(sid: str, body: TestRequest):
        return measurements.request(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/candidates", dependencies=[Depends(user_scope)])
    def candidate(sid: str, body: CandidateInput):
        return measurements.typed_candidate(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/candidates/ocr", dependencies=[Depends(user_scope)])
    def meter_crop(sid: str, body: MeterCropInput):
        from ohmpath.vision.ocr import OcrFailed, OcrUnavailable, recognize_meter_crop
        state = store.get(sid)
        active = measurements.active(state)
        if body.request_id != active["request_id"]:
            raise DomainError("ocr_request_changed", "Select an image for the current measurement request.")
        try:
            raw = base64.b64decode(body.image_base64, validate=True)
            parsed = recognize_meter_crop(raw, active["request_id"], active["meter_mode"], active["meter_mode"])
        except OcrUnavailable:
            raise DomainError("ocr_unavailable", "Optical meter reading needs a reviewed local Tesseract installation. You can enter and confirm the reading manually.", 503) from None
        except (ValueError, OcrFailed, OSError) as error:
            raise DomainError("ocr_failed", str(error)[:500], 422) from None
        def record(current, emit):
            request = measurements.active(current)
            if request["request_id"] != active["request_id"] or request["measurement_context_hash"] != active["measurement_context_hash"]:
                raise DomainError("ocr_context_changed", "The meter setup changed during recognition; select a fresh crop.")
            emit("meter.image_processed", {"image_sha256": hashlib.sha256(raw).hexdigest(),
                 "mode_source": "user_request_not_optically_verified", "image_retained": False}, source="user")
            return measurements._capture(current, emit, request, parsed)
        return store.transact(sid, record)

    @app.post("/v1/sessions/{sid}/readback", dependencies=[Depends(user_scope)])
    def readback(sid: str, body: ReadbackInput):
        return measurements.readback(sid, body.confirmation_id)

    @app.post("/v1/sessions/{sid}/confirm", dependencies=[Depends(user_scope)])
    def confirm(sid: str, body: ConfirmInput):
        return measurements.confirm(sid, **body.model_dump())

    @app.post("/v1/sessions/{sid}/pause", dependencies=[Depends(user_scope)])
    def pause(sid: str):
        investigations.cancel(sid)
        def update(state, emit):
            cancel_pending(state)
            state.update(status="paused", hardware_state="disarmed", arming_epoch=opaque_id())
            emit("session.paused", {"reason": "Local stop"})
        return store.transact(sid, update)

    @app.post("/v1/sessions/{sid}/fixture", dependencies=[Depends(user_scope)])
    def select_fixture(sid: str, body: FixtureInput):
        investigations.cancel(sid)
        graph = load_fixture(body.name)
        def update(state, emit):
            cancel_pending(state)
            state.update(fixture=body.name, power_state="unknown", setup={}, status="active")
            state.pop("imported_graph", None)
            state.pop("pending_import", None)
            state["revisions"]["circuit_revision"] = opaque_id()
            state["revisions"]["calibration_revision"] = None
            state["known_nodes"] = sorted({n for c in graph.components for n in c.nodes})
            state["nominal_source_voltage_v"] = sum(c.value_si for c in graph.components if c.kind == "dc_voltage_source")
            emit("circuit.selected", {"fixture": body.name, "graph": graph.model_dump(mode="json")})
        return store.transact(sid, update)

    @app.get("/v1/sessions/{sid}/graph", dependencies=[Depends(role)])
    def graph(sid: str):
        state = store.get(sid)
        graph_id = store.circuit_evidence(sid, state["revisions"]["circuit_revision"])
        return {"graph": accepted_graph(state).model_dump(mode="json"), "revisions": state["revisions"],
                "evidence_ids": [graph_id] if graph_id else []}

    @app.post("/v1/sessions/{sid}/imports", dependencies=[Depends(user_scope)])
    def preview_import(sid: str, body: SchematicInput):
        from ohmpath.circuits.kicad import import_kicad_schematic
        state = store.get(sid)
        try:
            source = base64.b64decode(body.schematic_base64, validate=True)
            if len(source) > 5_000_000 or not source.lstrip().startswith(b"(kicad_sch"):
                raise ValueError("Select a supported KiCad schematic under 5 MB.")
            import_id = opaque_id()
            directory = data_dir / "imports" / sid / import_id
            directory.mkdir(parents=True)
            path = directory / "source.kicad_sch"
            path.write_bytes(source)
            imported = import_kicad_schematic(path, source_root=directory)
        except (ValueError, OSError, RuntimeError) as error:
            raise DomainError("schematic_import_failed", str(error)[:2000], 422) from None
        preview = {"import_id": import_id, "graph": imported.model_dump(mode="json"),
                   "source_sha256": hashlib.sha256(source).hexdigest(),
                   "warnings": ["Only the reviewed resistor/DC-source model subset is supported.",
                                "Physical wiring, ERC classification and original symbol appearance are not verified."]}
        def record(current, emit):
            if current["revisions"] != state["revisions"]:
                raise DomainError("import_context_changed", "The circuit changed during import; select the schematic again.")
            current["pending_import"] = preview
            emit("circuit.import_preview", preview, source="user")
        store.transact(sid, record)
        return preview

    @app.post("/v1/sessions/{sid}/imports/accept", dependencies=[Depends(user_scope)])
    def accept_import(sid: str, body: ImportInput):
        investigations.cancel(sid)
        def accept(current, emit):
            preview = current.get("pending_import")
            if not preview or preview["import_id"] != body.import_id:
                raise DomainError("import_expired", "Select and review a fresh circuit import.")
            imported = CircuitGraph.model_validate_json(json.dumps(preview["graph"]))
            cancel_pending(current)
            current.update(fixture="imported", imported_graph=preview["graph"], power_state="unknown", setup={},
                           status="active", hardware_state="disarmed", arming_epoch=opaque_id())
            current["revisions"]["circuit_revision"] = opaque_id()
            current["revisions"]["calibration_revision"] = None
            current["known_nodes"] = sorted({n for c in imported.components for n in c.nodes})
            current["nominal_source_voltage_v"] = sum(c.value_si for c in imported.components if c.kind == "dc_voltage_source")
            current.pop("pending_import", None)
            emit("circuit.import_accepted", preview, source="user")
        return store.transact(sid, accept)

    @app.post("/v1/sessions/{sid}/simulate", dependencies=[Depends(user_scope)])
    def simulate(sid: str):
        state = store.get(sid)
        if not simulation_slots.acquire(blocking=False):
            raise DomainError("simulation_busy", "Wait for the current local simulation to finish.", 429)
        try:
            result = run_operating_point(accepted_graph(state), work_root=data_dir / "simulations")
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

    @app.post("/v1/sessions/{sid}/laboratory", dependencies=[Depends(user_scope)])
    def laboratory(sid: str, body: LaboratoryInput):
        from ohmpath.circuits.laboratory import run_diode_sweep, run_rc_transient
        state = store.get(sid)
        if not simulation_slots.acquire(blocking=False):
            raise DomainError("simulation_busy", "Wait for the current local simulation to finish.", 429)
        try:
            if body.template == "rc":
                result = run_rc_transient(body.resistance_ohm, body.capacitance_f, body.supply_v,
                                          work_root=data_dir / "simulations")
            else:
                result = run_diode_sweep(body.resistance_ohm, body.supply_v,
                                         work_root=data_dir / "simulations")
        except ValueError as error:
            raise DomainError("laboratory_input_invalid", str(error), 422) from None
        finally:
            simulation_slots.release()
        result["scope"] = "independent_educational_template_not_selected_circuit"
        result["physical_verification"] = "pending"
        def record(current, emit):
            if current["revisions"] != state["revisions"]:
                raise DomainError("laboratory_context_changed", "The session circuit changed; run the template again.")
            event = emit("laboratory.simulation_finished", result)
            return {**result, "evidence_ids": [event["event_id"]]}
        return store.transact(sid, record)

    @app.post("/v1/sessions/{sid}/diagnose", dependencies=[Depends(user_scope)])
    def diagnose(sid: str):
        from ohmpath.circuits.diagnosis import diagnose_circuit
        state = store.get(sid)
        confirmed = current_readings(state)
        selected = [e for e in confirmed if e["payload"]["candidate"]["display_state"] == "numeric"
                    and e["payload"]["candidate"]["si_unit"] == "V" and e["payload"]["request"]["meter_mode"] == "DC_voltage"][-12:]
        readings = [{"red_node_id": e["payload"]["request"]["red_node_id"],
                     "black_node_id": e["payload"]["request"]["black_node_id"],
                     "value_v": float(e["payload"]["candidate"]["value"]), "evidence_id": e["event_id"]} for e in selected]
        if not simulation_slots.acquire(blocking=False):
            raise DomainError("simulation_busy", "Wait for the current local simulation to finish.", 429)
        try:
            result = diagnose_circuit(accepted_graph(state), readings, work_root=data_dir / "simulations")
        except ValueError as error:
            raise DomainError("diagnosis_profile_unsupported", str(error), 422) from None
        finally:
            simulation_slots.release()
        simulations = result.pop("simulations")
        result.update(source="simulation_comparison", circuit_revision=state["revisions"]["circuit_revision"],
                      input_evidence_kind="simulated_user_input" if state["mode"] == "mock" else "user_reported_physical_measurement")
        if state.get("nominal_source_voltage_v", 0) > 12:
            result["next_test"] = None
            result["limitations"].append("The imported source exceeds the initial 12 V measurement profile; no physical test is proposed.")
        def record(current, emit):
            if current["revisions"] != state["revisions"] or current["arming_epoch"] != state["arming_epoch"]:
                raise DomainError("diagnosis_context_changed", "The circuit or setup changed; run a fresh comparison.")
            ids = [e["event_id"] for e in selected]
            for item in simulations:
                ids.append(emit("simulation.variant_finished", item)["event_id"])
            result["evidence_ids"] = ids
            event = emit("diagnosis.compared", result)
            result["diagnosis_event_id"] = event["event_id"]
            return result
        return store.transact(sid, record)

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

    @app.get("/v1/voice/status", dependencies=[Depends(user_scope)])
    def voice_status():
        return speech.status()

    @app.post("/v1/voice/transcribe-question", dependencies=[Depends(user_scope)])
    def transcribe_photo_question(body: PhotoAudioInput):
        # A photo question is a draft. It cannot enter the measurement ledger or
        # start an investigator merely because recognition returned some text.
        try:
            audio = base64.b64decode(body.wav_base64, validate=True)
        except (binascii.Error, ValueError):
            raise DomainError("speech_audio_invalid", "The audio payload is invalid.", 422) from None
        transcript = speech.transcribe(audio)
        return {"text": transcript["text"], "status": transcript["status"], "local_only": True}

    @app.get("/v1/sessions/{sid}/assembly", dependencies=[Depends(user_scope)])
    def assembly(sid: str):
        state = store.get(sid)
        return logical_assembly_guide(accepted_graph(state), state["revisions"]["circuit_revision"])

    @app.post("/v1/sessions/{sid}/firmware/analyze", dependencies=[Depends(user_scope)])
    def firmware_analyze(sid: str, body: FirmwareInput):
        state = store.get(sid)
        configuration = (f"Board: {body.board}\n" if body.board else "") + (f"baud: {body.baud_rate}" if body.baud_rate else "")
        try:
            report = parse_firmware_evidence(captured_at=utc_now(), firmware_revision=state["revisions"]["firmware_revision"],
                                             serial_text=body.log_text, configuration_text=configuration)
        except ValueError as error:
            raise DomainError("firmware_input_invalid", str(error), 422) from None
        result = {"source": "user_supplied_log", "firmware_revision": report.firmware_revision,
                  "observations": [{"kind": obs.source, "summary": obs.text, "line_numbers": [obs.line_number],
                                     "evidence_id": obs.evidence_id} for obs in report.observations],
                  "hypotheses": [{"title": hyp.category.replace("_", " "), "reason": hyp.statement,
                                   "checks": [check.instruction for check in report.checks if set(check.required_evidence) & set(hyp.supporting_evidence_ids)],
                                   "status": "candidate"} for hyp in report.hypotheses],
                  "physical_verification": "pending", "input_sha256": report.raw_input_sha256}
        def record(current, emit):
            if current["revisions"] != state["revisions"]:
                raise DomainError("firmware_context_changed", "Firmware or circuit changed; review the new context.")
            emit("firmware.log_analyzed", result, source="user")
        store.transact(sid, record)
        return result

    @app.post("/v1/sessions/{sid}/investigate", dependencies=[Depends(user_scope)])
    def investigate(sid: str, body: InvestigationInput):
        with investigation_admission:
            if photo_help.busy():
                raise DomainError("investigator_busy", "Wait for or cancel the current photo help.", 429)
            return investigations.start(sid, body.question)

    @app.post("/v1/sessions/{sid}/investigate/image", dependencies=[Depends(user_scope)])
    def investigate_image(sid: str, body: ImageInvestigationInput):
        try:
            raw = base64.b64decode(body.image_base64, validate=True)
        except binascii.Error:
            raise DomainError("investigation_image_invalid", "Choose a valid PNG or JPEG image.", 422) from None
        with investigation_admission:
            if photo_help.busy():
                raise DomainError("investigator_busy", "Wait for or cancel the current photo help.", 429)
            return investigations.start(sid, body.question, image_bytes=raw)

    @app.get("/v1/sessions/{sid}/investigate/{turn_id}", dependencies=[Depends(user_scope)])
    def investigation_status(sid: str, turn_id: str):
        return investigations.status(sid, turn_id)

    @app.post("/v1/sessions/{sid}/investigate/cancel", dependencies=[Depends(user_scope)])
    def investigation_cancel(sid: str, body: TurnInput):
        return investigations.cancel(sid, body.turn_id)

    @app.post("/v1/photo-help/investigate", dependencies=[Depends(user_scope)])
    def investigate_photos(body: PhotoHelpInput):
        with investigation_admission:
            with investigations.lock:
                if any(job["worker"].is_alive() for job in investigations.jobs.values()):
                    raise DomainError("investigator_busy", "Wait for or cancel the current investigation.", 429)
            return photo_help.start(body.context_id, body.question,
                                    [image.model_dump() for image in body.images])

    @app.get("/v1/photo-help/{turn_id}", dependencies=[Depends(user_scope)])
    def photo_help_status(turn_id: str):
        return photo_help.status(turn_id)

    @app.post("/v1/photo-help/cancel", dependencies=[Depends(user_scope)])
    def photo_help_cancel(body: PhotoCancelInput):
        return photo_help.cancel(body.context_id, body.turn_id)

    @app.get("/v1/sessions/{sid}/aim/status", dependencies=[Depends(user_scope)])
    def aim_status(sid: str):
        store.get(sid)
        return {"mode": "simulation", "laser_enabled": False, "hardware_state": "disarmed",
                "camera": "synthetic", "calibration": "synthetic_demo_only"}

    @app.post("/v1/sessions/{sid}/calibration/fit", dependencies=[Depends(user_scope)])
    def fit_calibration(sid: str, body: CalibrationFitInput):
        from ohmpath_pi.calibration import JacobianSample, fit_local_calibration
        from ohmpath_pi.models import RevisionSnapshot
        state = store.get(sid)
        if state["revisions"]["circuit_revision"] != body.circuit_revision:
            raise DomainError("calibration_context_changed", "The circuit changed; review the samples in the new context.")
        revisions = RevisionSnapshot(body.circuit_revision, state["revisions"]["firmware_revision"], opaque_id())
        def sample(item):
            return JacobianSample(**item.model_dump(), circuit_revision=revisions.circuit_revision,
                                  firmware_revision=revisions.firmware_revision, calibration_revision=revisions.calibration_revision)
        try:
            fit = fit_local_calibration([sample(item) for item in body.fit_samples],
                                        [sample(item) for item in body.validation_samples],
                                        revisions=revisions, data_source=body.data_source)
        except (ValueError, TypeError) as error:
            raise DomainError("calibration_input_invalid", str(error)[:500], 422) from None
        result = {**asdict(fit), "applied": False, "scope": "offline_candidate_only",
                  "samples_sha256": hashlib.sha256(body.model_dump_json().encode()).hexdigest()}
        def record(current, emit):
            if current["revisions"] != state["revisions"]:
                raise DomainError("calibration_context_changed", "The circuit changed; discard this candidate fit.")
            event = emit("calibration.candidate_fitted", result, source="user")
            return {**result, "evidence_ids": [event["event_id"]]}
        return store.transact(sid, record)

    @app.post("/v1/sessions/{sid}/aim/demo", dependencies=[Depends(user_scope)])
    def aim_demo(sid: str, body: AimInput):
        from ohmpath_pi.controller import run_aim_demo
        initial = store.get(sid)
        if initial["status"] != "active":
            raise DomainError("session_paused", "Save and review the session setup before running another aiming simulation.")
        result = run_aim_demo(body.target_x, body.target_y)
        def record(state, emit):
            if state["status"] != "active" or state["arming_epoch"] != initial["arming_epoch"]:
                raise DomainError("aim_context_changed", "The session was paused; discard this simulated aiming result.")
            emit("aim.simulated", {"target_pixel": [body.target_x, body.target_y],
                 "converged": result["converged"], "fault": result["fault"], "mode": "simulation",
                 "laser_enabled": False, "frame_count": len(result["frames"])})
        store.transact(sid, record)
        return result

    @app.post("/v1/sessions/{sid}/question", dependencies=[Depends(user_scope)])
    def question(sid: str, body: QuestionInput):
        state = store.get(sid)
        recent = [e for e in store.recent_events(sid, 100) if e["circuit_revision"] == state["revisions"]["circuit_revision"]]
        simulations = [e for e in recent if e["event_type"] == "simulation.finished" and e["payload"]["status"] == "succeeded"]
        confirmed = current_readings(state)
        references = []
        text = "I can compare the accepted circuit with local simulation and confirmed readings. "
        if simulations:
            simulation = simulations[-1]
            references.append(simulation["event_id"])
            values = simulation["payload"]["node_voltages_v"]
            text += "The latest ngspice prediction is " + ", ".join(f"{n}: {v:g} V" for n, v in values.items()) + ". "
        else:
            text += "Run the local solve to get a numeric reference. "
        if confirmed:
            event = confirmed[-1]
            references.append(event["event_id"])
            candidate = event["payload"]["candidate"]
            evidence_label = "practice input" if event["payload"]["evidence_kind"] == "simulated_user_input" else "user-reported reading"
            text += f"The latest confirmed {evidence_label} is {candidate['value'] or candidate['display_state']} {candidate['si_unit'] or ''}. "
        else:
            text += "There is no confirmed reading for this circuit revision yet. "
        text += "Simulation does not establish the physical wiring or a unique fault."
        result = {"text": text, "evidence_ids": references, "source": "local_evidence_summary",
                  "limitations": ["This is a local evidence summary; use Investigate for a subscription-backed answer",
                                  "Practice session; no physical measurement verified" if state["mode"] == "mock"
                                  else "Manual session; user-reported readings are not instrument verified"]}
        def record(current, emit):
            if current["revisions"] != state["revisions"] or current["arming_epoch"] != state["arming_epoch"]:
                raise DomainError("question_context_changed", "The circuit or setup changed while preparing this answer.")
            emit("question.asked", {"text": body.text}, source="user")
            emit("explanation.generated", result)
            return result
        return store.transact(sid, record)

    @app.post("/v1/sessions/{sid}/voice/text", dependencies=[Depends(user_scope)])
    def voice_text(sid: str, body: VoiceInput):
        if not body.final or body.own_speech or not body.text.strip():
            return {"route": "silence", "result": None}
        def reserve(state, emit):
            seen = state.setdefault("utterance_ids", [])
            if body.utterance_id in seen:
                raise DomainError("utterance_already_processed", "This utterance has already been processed.")
            seen.append(body.utterance_id)
            state["utterance_ids"] = seen[-1000:]
            emit("voice.final_transcript", {"text": body.text, "utterance_id": body.utterance_id}, source="user")
        store.transact(sid, reserve)
        route = route_utterance(body.text)
        if route == "question":
            result = question(sid, QuestionInput(text=body.text))
        elif route == "stop":
            result = pause(sid)
        elif route == "confirmation":
            state = store.get(sid)
            conf = state["confirmation"]
            if conf is None or body.confirmation_id != conf["confirmation_id"] or body.request_id != conf["request_id"]:
                raise DomainError("voice_confirmation_unbound", "A spoken yes must name the current completed readback challenge.")
            result = measurements.confirm(sid, **{k: conf[k] for k in ("confirmation_id", "candidate_id", "request_id", "measurement_context_hash", "revisions")})
        else:
            def capture(state, emit):
                req = measurements.active(state)
                if body.request_id != req["request_id"]:
                    raise DomainError("voice_request_unbound", "Start a measurement test before reading a value aloud.")
                candidate = parse_reading(body.text, req["request_id"], meter_mode=req["meter_mode"])
                if candidate.si_unit is not None and candidate.si_unit not in req["permitted_units"]:
                    candidate.ambiguities.append("The unit does not match the active meter test.")
                return measurements._capture(state, emit, req, candidate)
            result = store.transact(sid, capture)
        return {"route": route, "result": result, **({"question": body.text} if route == "question" else {})}

    @app.post("/v1/sessions/{sid}/voice/transcribe", dependencies=[Depends(user_scope)])
    def transcribe(sid: str, body: AudioInput):
        state = store.get(sid)
        try:
            audio = base64.b64decode(body.wav_base64, validate=True)
        except binascii.Error:
            raise DomainError("speech_audio_invalid", "The audio payload is invalid.", 422) from None
        transcript = speech.transcribe(audio)
        if store.get(sid)["revisions"] != state["revisions"]:
            raise DomainError("speech_context_changed", "The circuit changed during transcription; repeat the utterance.")
        response = voice_text(sid, VoiceInput(**{**body.model_dump(exclude={"wav_base64"}), "text": transcript["text"]}))
        return {"transcript": transcript, **response}

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
