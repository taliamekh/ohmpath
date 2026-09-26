import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DevicesPage from "./DevicesPage";
import TroubleshootPage from "./TroubleshootPage";
import CircuitLabPage from "./CircuitLabPage";
import ElevenLabsSettings from "./ElevenLabsSettings";

type AnyRecord = Record<string, any>;
type Tab = "bench" | "troubleshoot" | "laboratory" | "devices" | "settings";
type PowerState = "unknown" | "on_current_limited" | "off_verified";
type GuideActivity = "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";
type Capture = { stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode; chunks: Float32Array[]; startedAt: number; timer: number; generation: number; sid: string };

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "bench", label: "Bench", icon: "⌘" },
  { id: "troubleshoot", label: "Troubleshoot", icon: "⌁" },
  { id: "laboratory", label: "Circuit lab", icon: "∿" },
  { id: "devices", label: "Devices", icon: "⌑" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

const safeChecks = [
  ["power_disconnected", "Supply physically disconnected"],
  ["stored_energy_addressed", "Stored energy addressed"],
  ["residual_voltage_verified", "Residual voltage checked"],
  ["path_isolated", "Measurement path isolated"],
] as const;

function unpack<T = any>(raw: unknown): T {
  if (raw && typeof raw === "object") {
    const result = raw as AnyRecord;
    if (result.error) throw new Error(result.message || String(result.error));
    if (Object.prototype.hasOwnProperty.call(result, "data")) return result.data as T;
  }
  return raw as T;
}

async function request<T = any>(action: string, payload?: AnyRecord): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("The local bench connection is not available.");
  return unpack<T>(await window.ohmpath.request(action, payload));
}

function fmt(value: unknown, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : "—";
}

function niceName(value: string) {
  return value.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function App() {
  const [tab, setTab] = useState<Tab>("bench");
  const [health, setHealth] = useState<AnyRecord | null>(null);
  const [sessions, setSessions] = useState<AnyRecord[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<AnyRecord | null>(null);
  const [graph, setGraph] = useState<AnyRecord | null>(null);
  const [events, setEvents] = useState<AnyRecord[]>([]);
  const [simulation, setSimulation] = useState<AnyRecord | null>(null);
  const [diagnosis, setDiagnosis] = useState<AnyRecord | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showGuide, setShowGuide] = useState(true);
  const [companionEnabled, setCompanionEnabled] = useState(false);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [companionError, setCompanionError] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [newSessionName, setNewSessionName] = useState("Practice bench");
  const [newSessionMode, setNewSessionMode] = useState<"mock" | "supervised">("mock");
  const [showNewSession, setShowNewSession] = useState(false);
  const [investigatorPrefill, setInvestigatorPrefill] = useState("");
  const [quantity, setQuantity] = useState("voltage");
  const [meterMode, setMeterMode] = useState("DC_voltage");
  const [redNode, setRedNode] = useState("");
  const [blackNode, setBlackNode] = useState("");
  const [meterRange, setMeterRange] = useState("auto");
  const [setupPower, setSetupPower] = useState<PowerState>("unknown");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [readingText, setReadingText] = useState("");
  const [correctionEvent, setCorrectionEvent] = useState("");
  const [readbackAcknowledged, setReadbackAcknowledged] = useState(false);
  const [activity, setActivity] = useState<GuideActivity>("idle");
  const [voiceStatus, setVoiceStatus] = useState<AnyRecord | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [localSpeechEnabled, setLocalSpeechEnabled] = useState(false);
  const [localVoice, setLocalVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [transcriptTest, setTranscriptTest] = useState("");
  const [voiceReply, setVoiceReply] = useState<AnyRecord | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const speechCancelledRef = useRef(false);
  const activeSpeechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechGenerationRef = useRef(0);
  const voiceGenerationRef = useRef(0);
  const sessionIdRef = useRef("");
  const sessionStatusRef = useRef<string>("unknown");
  const lastCompanionPayloadRef = useRef("");

  const run = useCallback(async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError("");
    setNotice("");
    setActivity("thinking");
    try {
      return await work();
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "The request could not be completed.";
      setError(message);
      setActivity("error");
      return undefined;
    } finally {
      setBusy("");
      setActivity((current) => current === "error" ? current : session?.status === "paused" ? "paused" : "idle");
    }
  }, [session?.status]);

  const loadSession = useCallback(async (sid: string) => {
    if (!sid) return;
    const [nextSession, graphResult, eventResult] = await Promise.all([
      request<AnyRecord>("session", { sid }),
      request<AnyRecord>("graph", { sid }),
      request<AnyRecord[]>("events", { sid, after: 0 }),
    ]);
    if (sessionIdRef.current && sessionIdRef.current !== sid) cancelVoiceActivity();
    setSession(nextSession);
    setVoiceReply(null);
    setGraph(graphResult?.graph ?? graphResult);
    setEvents(eventResult ?? []);
    setSessionId(sid);
    sessionIdRef.current = sid;
    sessionStatusRef.current = nextSession.status;
    setSimulation(null);
    setDiagnosis(null);
    setSetupPower(nextSession.power_state ?? "unknown");
    setChecks(nextSession.setup ?? {});
    const nodeList = Array.from(new Set((graphResult?.graph?.components ?? graphResult?.components ?? []).flatMap((part: AnyRecord) => part.nodes))) as string[];
    setRedNode((current) => nodeList.includes(current) ? current : nodeList[0] ?? "");
    setBlackNode((current) => nodeList.includes(current) && current !== (nodeList[0] ?? "") ? current : nodeList[1] ?? "");
    setReadbackAcknowledged(false);
  }, []);

  const refreshEvents = useCallback(async (sid = sessionId) => {
    if (!sid) return;
    const latest = await request<AnyRecord[]>("events", { sid, after: 0 });
    setEvents(latest ?? []);
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [initialHealth, list] = await Promise.all([
          request<AnyRecord>("health"),
          request<AnyRecord[]>("sessions"),
        ]);
        if (!alive) return;
        setHealth(initialHealth);
        setSessions(list ?? []);
        const resumable = (list ?? []).find((entry) => entry.status === "active") ?? (list ?? [])[0];
        if (resumable) await loadSession(resumable.session_id);
      } catch (problem) {
        if (alive) {
          setError(problem instanceof Error ? problem.message : "Could not reach the local bench service.");
          setActivity("error");
        }
      }
    })();
    return () => { alive = false; };
  }, [loadSession]);

  useEffect(() => {
    request<AnyRecord>("voiceStatus").then(setVoiceStatus).catch((problem) => {
      setVoiceStatus({ provider: "whisper.cpp", model: "small.en", status: "not_installed", local_only: true, microphone: "user_controlled", recording: false, hands_free: "unverified", error: problem instanceof Error ? problem.message : "Status unavailable" });
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.ohmpath?.onServiceStopped?.(() => {
      cancelVoiceActivity();
      sessionStatusRef.current = "unavailable";
      sessionIdRef.current = "";
      setHealth(null);
      setSession(null);
      setSessionId("");
      setGraph(null);
      setEvents([]);
      setSimulation(null);
      setDiagnosis(null);
      setVoiceReply(null);
      setError("The local bench service stopped. Restart the desktop app to reconnect; pending confirmations were cleared.");
      setNotice("");
      setActivity("error");
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => window.ohmpath?.onCompanionClosed?.(() => setCompanionEnabled(false)), []);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const updateVoices = () => {
      const available = window.speechSynthesis.getVoices().filter((voice) => voice.localService === true);
      setLocalVoice((current) => current && available.includes(current) ? current : available[0] ?? null);
    };
    updateVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", updateVoices);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", updateVoices);
  }, []);

  useEffect(() => () => {
    const capture = captureRef.current;
    if (capture) {
      window.clearTimeout(capture.timer);
      capture.processor.disconnect();
      capture.source.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      void capture.context.close();
    }
    speechGenerationRef.current += 1;
    activeSpeechRef.current = null;
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => {
    if (!session) return;
    setActivity(session.status === "paused" ? "paused" : "idle");
  }, [session?.status]);

  const components = graph?.components ?? [];
  const nodes = useMemo(() => Array.from(new Set(components.flatMap((part: AnyRecord) => part.nodes))) as string[], [components]);
  const activeRequest = session?.active_request;
  const candidate = session?.pending_candidate;
  const confirmation = session?.confirmation;
  const companionCaption = useMemo(() => {
    let text = "";
    if (readbackAcknowledged && confirmation?.readback_text) text = confirmation.readback_text;
    else if (activity === "paused") text = "Session paused. No physical output is enabled.";
    else if (activity === "error") text = error || "A local operation needs attention.";
    else if (activity === "listening") text = "Microphone active for push-to-talk.";
    else if (activity === "thinking") text = "Request in progress.";
    else if (activity === "speaking") text = "Local read-aloud in progress.";
    else if (voiceState === "transcribing") text = "Transcribing with the local speech model.";
    else if (voiceStatus && ["ready", "installed"].includes(voiceStatus.status)) text = "Local speech model available. Microphone off.";
    else text = "No active guide message.";
    return text.slice(0, 500);
  }, [readbackAcknowledged, confirmation?.readback_text, activity, error, voiceState, voiceStatus]);

  useEffect(() => {
    if (!companionEnabled) { lastCompanionPayloadRef.current = ""; return; }
    const state = { activity, caption: companionCaption, reducedMotion };
    const serialized = JSON.stringify(state);
    if (serialized === lastCompanionPayloadRef.current) return;
    lastCompanionPayloadRef.current = serialized;
    request("updateCompanion", state).catch((problem) => {
      setCompanionError(problem instanceof Error ? problem.message : "Could not update the desktop companion.");
    });
  }, [companionEnabled, activity, companionCaption, reducedMotion]);
  const confirmedEvents = events.filter((event) => event.event_type === "measurement.confirmed");
  const supersededEventIds = new Set(events.map((event) => event.supersedes_event_id).filter((eventId) => typeof eventId === "string"));
  const correctionContextHash = activeRequest && confirmation?.request_id === activeRequest.request_id
    && confirmation?.measurement_context_hash === activeRequest.measurement_context_hash
    ? confirmation.measurement_context_hash : "";
  const correctableEvents = correctionContextHash ? confirmedEvents.filter((event) => {
    const priorRequest = event.payload?.request;
    return !supersededEventIds.has(event.event_id)
      && event.circuit_revision === session?.revisions?.circuit_revision
      && priorRequest?.quantity === activeRequest?.quantity
      && priorRequest?.meter_mode === activeRequest?.meter_mode
      && priorRequest?.red_node_id === activeRequest?.red_node_id
      && priorRequest?.black_node_id === activeRequest?.black_node_id
      && priorRequest?.measurement_context_hash === correctionContextHash;
  }) : [];
  const latestSimulation = simulation ?? [...events].reverse().find((event) => event.event_type === "simulation.finished")?.payload;
  const hardwareLabel = health?.hardware === "disabled" ? "Disabled" : "Unknown";
  const reasoningLabel = health?.reasoning === "subscription_on_request" ? "Subscription · on request" : health?.reasoning === "blocked_pending_permission_proof" ? "Paused · permission review" : "Unavailable";
  const voiceOverviewLabel = ["ready", "installed"].includes(voiceStatus?.status) ? "Local Whisper · mic off" : voiceStatus?.status === "not_installed" ? "Speech model missing" : "Checking local voice";
  const canMeasure = Boolean(sessionId && session?.status === "active" && nodes.length > 1 && redNode && blackNode && redNode !== blackNode);
  const resistorChecksPass = safeChecks.every(([key]) => checks[key] === true);
  const setupReady = quantity === "voltage"
    ? setupPower === "on_current_limited" && checks.low_voltage_confirmed === true
    : setupPower === "off_verified" && resistorChecksPass;
  const setupSaved = session?.power_state === setupPower
    && Object.keys(checks).every((key) => session?.setup?.[key] === checks[key])
    && Object.keys(session?.setup ?? {}).every((key) => checks[key] === session?.setup?.[key]);
  const activityLabel: Record<GuideActivity, string> = {
    idle: "Guide idle", listening: "Listening", thinking: "Checking locally", speaking: "Speaking",
    paused: "Guide paused", error: "Connection issue",
  };
  const isManualSession = session?.mode === "supervised";
  const graphTitle = graph?.title ?? graph?.name ?? (graph?.circuit_id === "loaded_divider" ? "Loaded divider" : graph?.circuit_id === "divider" ? "Resistor divider" : graph?.circuit_id ? niceName(String(graph.circuit_id)) : "Circuit graph");
  const proposedTest = diagnosis?.next_test;
  const proposalReady = Boolean(proposedTest && !activeRequest && session?.status === "active"
    && session?.power_state === "on_current_limited" && session?.setup?.low_voltage_confirmed === true
    && nodes.includes(proposedTest.red_node_id) && nodes.includes(proposedTest.black_node_id)
    && proposedTest.red_node_id !== proposedTest.black_node_id);

  async function createSession() {
    await run("create", async () => {
      const created = await request<AnyRecord>("createSession", { name: newSessionName.trim() || (newSessionMode === "supervised" ? "Manual bench" : "Practice bench"), mode: newSessionMode });
      const sid = created.session_id;
      const list = await request<AnyRecord[]>("sessions");
      setSessions(list ?? []);
      await loadSession(sid);
      setShowNewSession(false);
      setNotice(newSessionMode === "supervised"
        ? "Manual bench created. Selecting this mode did not perform a test or take a measurement."
        : "Practice bench created. No physical measurements have been taken.");
      setNewSessionMode("mock");
    });
  }

  async function saveLocalReport() {
    await run("export", async () => {
      const result = await request<AnyRecord>("exportReport", { sid: sessionId });
      if (result?.cancelled) return;
      if (result?.saved !== true) throw new Error("The local summary was not saved.");
      setNotice("Local report saved. It excludes raw audio, images, firmware logs, and account details.");
    });
  }

  async function setFloatingCompanion(enabled: boolean) {
    setCompanionBusy(true);
    setCompanionError("");
    try {
      await request(enabled ? "openCompanion" : "closeCompanion");
      setCompanionEnabled(enabled);
      lastCompanionPayloadRef.current = "";
    } catch (problem) {
      setCompanionError(problem instanceof Error ? problem.message : "Could not change the floating companion window.");
    } finally { setCompanionBusy(false); }
  }

  function toggleLocalSpeech(enabled: boolean) {
    if (!enabled) cancelLocalSpeech();
    setLocalSpeechEnabled(enabled);
  }

  async function readSelectedMeterImage() {
    if (!activeRequest) return;
    await run("meter-image", async () => {
      let result: AnyRecord;
      try {
        result = await request<AnyRecord>("selectMeterCrop", { sid: sessionId, request_id: activeRequest.request_id });
      } catch (problem) {
        const message = problem instanceof Error ? problem.message : String(problem);
        if (/unsupported application action|meter_ocr_unavailable|ocr.*unavailable|no ocr engine|tesseract.*(?:unavailable|installation)/i.test(message)) {
          throw new Error("Experimental local meter OCR is unavailable in this build. No reading was recognized; you can type the value from your meter instead.");
        }
        throw problem;
      }
      if (result?.cancelled) return;
      if (!result?.candidate) throw new Error("No OCR candidate was returned. Nothing was confirmed; type the meter value instead.");
      await loadSession(sessionId);
      setReadbackAcknowledged(false);
      setReadingText("");
      setNotice(result.confirmation
        ? "Experimental OCR produced a pending candidate. Check the readback and explicitly confirm or replace it."
        : "The OCR result needs clarification. No value was confirmed; replace it with the reading you observed.");
    });
  }

  async function switchFixture(name: "divider" | "loaded-divider") {
    await run("fixture", async () => {
      await request("selectFixture", { sid: sessionId, name });
      await loadSession(sessionId);
      setNotice(`Loaded the ${name === "divider" ? "resistor divider" : "loaded divider"} fixture.`);
    });
  }

  async function importCircuit() {
    await run("import", async () => {
      const result = await request<AnyRecord>("importCircuit", { sid: sessionId });
      if (result?.cancelled) return;
      await loadSession(sessionId);
      const list = await request<AnyRecord[]>("sessions");
      setSessions(list ?? []);
      setNotice("KiCad circuit imported after local validation. Review the graph and setup declarations before continuing.");
    });
  }

  async function runDiagnosis() {
    const result = await run("diagnose", async () => request<AnyRecord>("diagnose", { sid: sessionId }));
    if (result) setDiagnosis(result);
  }

  function useProposedTest(test: AnyRecord) {
    setQuantity("voltage");
    setMeterMode("DC_voltage");
    setRedNode(test.red_node_id);
    setBlackNode(test.black_node_id);
    document.querySelector(".workflow-panel")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }

  async function saveSetup() {
    await run("setup", async () => {
      const setup = { ...checks, low_voltage_confirmed: setupPower === "on_current_limited" && checks.low_voltage_confirmed === true };
      await request("setup", { sid: sessionId, power_state: setupPower, setup });
      await loadSession(sessionId);
      setNotice(isManualSession ? "Your setup declarations were saved. Ohm Path has not verified the bench or activated an instrument." : "Practice setup saved. Ohm Path has not checked the physical bench.");
    });
  }

  async function requestTest() {
    await run("request", async () => {
      const result = await request<AnyRecord>("requestMeasurement", {
        sid: sessionId, quantity, meter_mode: meterMode, red_node_id: redNode,
        black_node_id: blackNode, meter_range: meterRange, instrument_id: "manual-meter", target_ids: [],
      });
      setCorrectionEvent("");
      await loadSession(sessionId);
      setNotice(`${isManualSession ? "Manual reading request ready" : "Practice step ready"}: ${result.quantity} between ${result.red_node_id} and ${result.black_node_id}. No instrument was activated.`);
    });
  }

  async function submitCandidate() {
    if (!activeRequest || !readingText.trim()) return;
    await run("candidate", async () => {
      const result = await request<AnyRecord>("candidate", {
        sid: sessionId, text: readingText, request_id: activeRequest.request_id,
      });
      await loadSession(sessionId);
      setReadbackAcknowledged(false);
      if (!result.confirmation) setNotice("Candidate needs clarification. It has not been accepted as evidence.");
      else setNotice("Candidate is ready for readback. Confirm it only after checking the wording and endpoints.");
    });
  }

  async function acknowledgeReadback() {
    if (!confirmation) return;
    await run("readback", async () => {
      await request("readback", { sid: sessionId, confirmation_id: confirmation.confirmation_id });
      await loadSession(sessionId);
      setReadbackAcknowledged(true);
      setNotice("Readback marked complete. You can now explicitly confirm this candidate.");
    });
  }

  async function confirmCandidate() {
    if (!confirmation || !candidate || !readbackAcknowledged) return;
    await run("confirm", async () => {
      const result = await request<AnyRecord>("confirm", {
        sid: sessionId,
        confirmation_id: confirmation.confirmation_id,
        candidate_id: candidate.candidate_id,
        request_id: confirmation.request_id,
        measurement_context_hash: confirmation.measurement_context_hash,
        revisions: confirmation.revisions,
        ...(correctionEvent ? { supersedes_event_id: correctionEvent } : {}),
      });
      await loadSession(sessionId);
      await refreshEvents(sessionId);
      setReadingText("");
      setCorrectionEvent("");
      const evidenceKind = result?.payload?.evidence_kind ?? result?.evidence_kind;
      setNotice(evidenceKind === "simulated_user_input"
        ? "Practice input confirmed and recorded as simulated user input."
        : evidenceKind === "user_reported_physical_measurement" || isManualSession
          ? "Confirmed as your user-reported physical measurement. Ohm Path did not verify it with an instrument."
          : "Candidate confirmation completed; evidence provenance was not reported.");
    });
  }

  async function runSimulation() {
    await run("simulate", async () => {
      const event = await request<AnyRecord>("simulate", { sid: sessionId });
      const result = event?.payload ?? event;
      setSimulation(result);
      await refreshEvents(sessionId);
      setNotice(result.status === "succeeded" ? "ngspice operating point completed." : "ngspice did not produce a successful result.");
    });
  }

  async function pauseSession() {
    cancelVoiceActivity();
    await run("pause", async () => {
      await request("pause", { sid: sessionId });
      await loadSession(sessionId);
      setNotice("Session paused. Hardware remains disabled.");
    });
  }

  async function stopSession() {
    if (!sessionId) return;
    cancelVoiceActivity();
    await run("stop", async () => {
      await request("stop", { sid: sessionId });
      await loadSession(sessionId);
      setNotice("Local stop accepted. Session paused; hardware remains disabled.");
    });
  }

  async function startPushToTalk() {
    if (!sessionId || voiceState !== "idle" || voiceStatus?.status === "not_installed") return;
    if (session?.status !== "active") return;
    const generation = ++voiceGenerationRef.current;
    const captureSid = sessionId;
    cancelLocalSpeech();
    setActivity("idle");
    setError("");
    setVoiceReply(null);
    setVoiceState("requesting");
    let openedStream: MediaStream | null = null;
    let openedContext: AudioContext | null = null;
    try {
      const permission = await request<AnyRecord>("enableMicrophone");
      if (generation !== voiceGenerationRef.current || captureSid !== sessionIdRef.current) return;
      if (permission?.allowed !== true) throw new Error("Microphone access was not enabled.");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This environment does not support microphone capture.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
      openedStream = stream;
      if (generation !== voiceGenerationRef.current || captureSid !== sessionIdRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      const AudioContextConstructor = window.AudioContext;
      const context = new AudioContextConstructor({ sampleRate: 16000 });
      openedContext = context;
      await context.resume();
      if (generation !== voiceGenerationRef.current || captureSid !== sessionIdRef.current) { stream.getTracks().forEach((track) => track.stop()); await context.close(); return; }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const capture: Capture = { stream, context, source, processor, chunks: [], startedAt: performance.now(), timer: 0, generation, sid: captureSid };
      processor.onaudioprocess = (audioEvent) => {
        const samples = audioEvent.inputBuffer.getChannelData(0);
        capture.chunks.push(samples.slice());
        audioEvent.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(context.destination);
      capture.timer = window.setTimeout(() => { void stopPushToTalk(true, true); }, 20_000);
      captureRef.current = capture;
      openedStream = null;
      openedContext = null;
      setVoiceState("recording");
      setRecordingSeconds(0);
      setActivity("listening");
      setNotice("Microphone is active for push-to-talk. Audio stays in memory until this request is sent.");
      const timer = window.setInterval(() => {
        if (!captureRef.current) { window.clearInterval(timer); return; }
        setRecordingSeconds(Math.min(20, Math.floor((performance.now() - capture.startedAt) / 1000)));
      }, 250);
    } catch (problem) {
      openedStream?.getTracks().forEach((track) => track.stop());
      if (openedContext && openedContext.state !== "closed") void openedContext.close();
      const message = problem instanceof Error ? problem.message : "Microphone access failed.";
      if (generation !== voiceGenerationRef.current) return;
      setVoiceState("idle");
      setActivity("error");
      setError(message);
    } finally {
      await request("disableMicrophone").catch(() => undefined);
    }
  }

  async function stopPushToTalk(send: boolean, timedOut = false) {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    window.clearTimeout(capture.timer);
    capture.processor.onaudioprocess = null;
    capture.processor.disconnect();
    capture.source.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    const sampleRate = capture.context.sampleRate;
    const duration = Math.min(20, (performance.now() - capture.startedAt) / 1000);
    await capture.context.close();
    if (capture.generation !== voiceGenerationRef.current || capture.sid !== sessionIdRef.current || sessionStatusRef.current !== "active") {
      setVoiceState("idle");
      setRecordingSeconds(0);
      return;
    }
    setVoiceState("idle");
    setActivity("idle");
    if (!send) { setRecordingSeconds(0); setNotice("Push-to-talk stopped. The captured audio was discarded."); return; }
    const samples = capture.chunks.length ? concatenate(capture.chunks) : new Float32Array();
    capture.chunks.length = 0;
    if (!samples.length) { setRecordingSeconds(0); setError("No audio was captured. Try again when the microphone is ready."); setActivity("error"); return; }
    const pcm = resample(samples, sampleRate, 16000);
    const wav = pcm16Wav(pcm, 16000);
    setVoiceState("transcribing");
    setRecordingSeconds(0);
    await run("transcribe", async () => {
      const result = await request<AnyRecord>("transcribe", {
        sid: capture.sid, wav_base64: toBase64(wav), utterance_id: crypto.randomUUID(),
        ...(activeRequest?.request_id ? { request_id: activeRequest.request_id } : {}),
        ...(confirmation?.confirmation_id ? { confirmation_id: confirmation.confirmation_id } : {}),
        final: true, own_speech: false,
      });
      if (capture.generation !== voiceGenerationRef.current || capture.sid !== sessionIdRef.current || sessionStatusRef.current !== "active") return;
      await handleVoiceResult(result);
      setNotice(`${result.transcript?.local_only ? "Local transcription" : "Transcription"} completed${timedOut ? " at the 20 second limit" : ""} (${fmt(result.transcript?.duration_seconds ?? duration, 1)} s).`);
    });
    setVoiceState("idle");
  }

  async function submitTranscriptTest() {
    if (!transcriptTest.trim() || !sessionId) return;
    const requestedSid = sessionId;
    const generation = voiceGenerationRef.current;
    await run("voice-test", async () => {
      const result = await request<AnyRecord>("voiceText", {
        sid: requestedSid, text: transcriptTest.trim(), utterance_id: crypto.randomUUID(),
        ...(activeRequest?.request_id ? { request_id: activeRequest.request_id } : {}),
        ...(confirmation?.confirmation_id ? { confirmation_id: confirmation.confirmation_id } : {}),
      });
      if (generation !== voiceGenerationRef.current || requestedSid !== sessionIdRef.current || sessionStatusRef.current !== "active") return;
      await handleVoiceResult(result, requestedSid, generation);
      setNotice("Typed transcript test routed locally. No microphone was used.");
    });
  }

  async function handleVoiceResult(response: AnyRecord, expectedSid = sessionIdRef.current, expectedGeneration = voiceGenerationRef.current) {
    if (!expectedSid || sessionIdRef.current !== expectedSid || voiceGenerationRef.current !== expectedGeneration || sessionStatusRef.current !== "active") return;
    setVoiceReply(response);
    const result = response.result ?? {};
    if (response.route === "reading") {
      await loadSession(sessionId);
      setReadbackAcknowledged(false);
      if (!result.confirmation) setNotice("Voice reading is an unconfirmed candidate that needs clarification.");
    } else if (response.route === "confirmation") {
      await loadSession(sessionId);
      await refreshEvents(sessionId);
      setReadbackAcknowledged(false);
    } else if (response.route === "stop") {
      await pauseSession();
    }
  }

  function speakReadback() {
    if (!confirmation || !localSpeechEnabled || !localVoice || !("speechSynthesis" in window) || sessionStatusRef.current !== "active" || !sessionIdRef.current) return;
    if (confirmation.readback_text.length > 12_000) { setError("This readback is too long for local speech. Use the on-screen text."); return; }
    window.speechSynthesis.cancel();
    const generation = ++speechGenerationRef.current;
    const sid = sessionIdRef.current;
    speechCancelledRef.current = false;
    const utterance = new SpeechSynthesisUtterance(confirmation.readback_text);
    utterance.voice = localVoice;
    activeSpeechRef.current = utterance;
    utterance.onstart = () => {
      if (generation === speechGenerationRef.current && sid === sessionIdRef.current && sessionStatusRef.current === "active") setActivity("speaking");
    };
    utterance.onend = () => {
      if (speechCancelledRef.current || generation !== speechGenerationRef.current || sid !== sessionIdRef.current || sessionStatusRef.current !== "active") return;
      activeSpeechRef.current = null;
      setActivity("idle");
      void acknowledgeReadback();
    };
    utterance.onerror = () => { if (!speechCancelledRef.current && generation === speechGenerationRef.current && sid === sessionIdRef.current && sessionStatusRef.current === "active") { activeSpeechRef.current = null; setActivity("error"); setError("Local speech could not finish. Use the manual readback check instead."); } };
    window.speechSynthesis.speak(utterance);
  }

  const cancelLocalSpeech = useCallback(() => {
    const wasSpeaking = activeSpeechRef.current !== null;
    speechGenerationRef.current += 1;
    activeSpeechRef.current = null;
    speechCancelledRef.current = true;
    window.speechSynthesis?.cancel();
    if (wasSpeaking) setActivity(sessionStatusRef.current === "paused" ? "paused" : "idle");
  }, []);

  useEffect(() => {
    cancelLocalSpeech();
  }, [sessionId, session?.revisions?.circuit_revision, session?.arming_epoch,
    activeRequest?.request_id, confirmation?.confirmation_id, cancelLocalSpeech]);

  const speakLocalText = useCallback((value: unknown) => {
    if (!localSpeechEnabled || !localVoice || !("speechSynthesis" in window) || sessionStatusRef.current !== "active" || !sessionIdRef.current) return;
    if (typeof value !== "string" || !value.trim()) return;
    const text = value.trim();
    if (text.length > 12_000) {
      setError("This response is too long for local read-aloud. Select a shorter explanation.");
      return;
    }
    window.speechSynthesis.cancel();
    const generation = ++speechGenerationRef.current;
    const sid = sessionIdRef.current;
    speechCancelledRef.current = false;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = localVoice;
    activeSpeechRef.current = utterance;
    utterance.onstart = () => {
      if (generation === speechGenerationRef.current && sid === sessionIdRef.current && sessionStatusRef.current === "active") setActivity("speaking");
    };
    utterance.onend = () => {
      if (speechCancelledRef.current || generation !== speechGenerationRef.current || sid !== sessionIdRef.current || sessionStatusRef.current !== "active") return;
      activeSpeechRef.current = null;
      setActivity("idle");
    };
    utterance.onerror = () => {
      if (speechCancelledRef.current || generation !== speechGenerationRef.current || sid !== sessionIdRef.current || sessionStatusRef.current !== "active") return;
      activeSpeechRef.current = null;
      setActivity("error");
      setError("Local speech could not finish. Captions remain available.");
    };
    window.speechSynthesis.speak(utterance);
  }, [localSpeechEnabled, localVoice]);

  function cancelVoiceActivity() {
    voiceGenerationRef.current += 1;
    sessionStatusRef.current = "paused";
    cancelLocalSpeech();
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      window.clearTimeout(capture.timer);
      capture.processor.onaudioprocess = null;
      capture.processor.disconnect();
      capture.source.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      if (capture.context.state !== "closed") void capture.context.close();
      capture.chunks.length = 0;
    }
    setVoiceState("idle");
    setRecordingSeconds(0);
    setActivity("paused");
  }

  function chooseQuantity(value: string) {
    setQuantity(value);
    setMeterMode(value === "voltage" ? "DC_voltage" : value);
  }

  return (
    <div className={`app-shell${reducedMotion ? " reduce-motion" : ""}`}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>Ω</span><i /></div>
          <div><strong>Ohm Path</strong><small>LOCAL CIRCUIT WORKSPACE</small></div>
        </div>
        <div className="workspace-label">WORKSPACE <span>DEMO</span></div>
        <nav className="side-nav" aria-label="Workspace">
          {tabs.map((item) => (
            <button className={`nav-item ${tab === item.id ? "selected" : ""}`} key={item.id} onClick={() => setTab(item.id)}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
              {item.id === "settings" && <span className="nav-soon">Setup</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-safety">
          <span className="safety-dot" />
          <div><strong>Physical output locked</strong><small>Laser and motion disabled</small></div>
        </div>
        <div className="sidebar-foot">Build preview <span>0.1</span></div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs"><span>Ohm Path</span><b>/</b><strong>{niceName(tab)}</strong></div>
          <div className="topbar-right">
            <span className={`practice-pill ${isManualSession ? "manual-mode-pill" : ""}`}><i /> {isManualSession ? "MANUAL · USER-REPORTED" : "PRACTICE ONLY"}</span>
            <button className="avatar-button" title="Guide settings" onClick={() => setShowGuide((visible) => !visible)}>G</button>
          </div>
        </header>

        <div className="scroll-area">
          {tab === "devices" ? (
            <DevicesPage sid={sessionId} paused={session?.status === "paused"} onStop={stopSession} />
          ) : tab === "troubleshoot" ? (
            <TroubleshootPage sessionId={sessionId} circuitRevision={session?.revisions?.circuit_revision ?? ""} contextEpoch={session?.arming_epoch ?? ""} prefillQuestion={investigatorPrefill} onPrefillConsumed={() => setInvestigatorPrefill("")} localSpeechAvailable={localSpeechEnabled && Boolean(localVoice) && session?.status === "active"} onReadAloud={speakLocalText} onStopSpeaking={cancelLocalSpeech} />
          ) : tab === "laboratory" ? (
            <CircuitLabPage sid={sessionId} />
          ) : tab === "settings" ? (
            <SettingsPage reducedMotion={reducedMotion} onReducedMotion={setReducedMotion} showGuide={showGuide} onShowGuide={setShowGuide} localSpeechEnabled={localSpeechEnabled} onLocalSpeech={toggleLocalSpeech} localVoice={localVoice} voiceStatus={voiceStatus} reasoningStatus={health?.reasoning} companionEnabled={companionEnabled} companionBusy={companionBusy} companionError={companionError} onCompanion={setFloatingCompanion} />
          ) : tab === "bench" ? (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">YOUR ELECTRONICS WORKSPACE</div>
                  <h1>{isManualSession ? "Manual bench" : "Practice bench"} <span className="heading-spark">✳</span></h1>
                  <p>{isManualSession ? "Enter readings from your own display. Each confirmed value remains user-reported and is not instrument verified." : "Explore a known circuit, compare a reading, and keep every result tied to its source."}</p>
                </div>
                <div className="session-picker">
                  <label htmlFor="session-select">SESSION</label>
                  <select id="session-select" value={sessionId} onChange={(event) => run("session", () => loadSession(event.target.value))}>
                    <option value="">Choose a bench…</option>
                    {sessions.map((item) => <option key={item.session_id} value={item.session_id}>{item.name} · {item.status}</option>)}
                  </select>
                  <button className="button secondary small report-export-button" onClick={saveLocalReport} disabled={!sessionId || Boolean(busy)}>{busy === "export" ? "Preparing report…" : "Save local report"}<span>↓</span></button>
                  <small className="report-export-note">Evidence summary only · excludes raw audio, images, firmware logs, and account details.</small>
                  <button className="text-button new-session-toggle" onClick={() => setShowNewSession((visible) => !visible)}>{showNewSession ? "Close new session" : "+ New session"}</button>
                  {showNewSession && <div className="new-session-popover"><label className="session-name-field"><span>SESSION NAME</span><input value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} maxLength={100} /></label><SessionModeOptions value={newSessionMode} onChange={setNewSessionMode} /><button className="button primary" onClick={createSession} disabled={Boolean(busy)}>{busy === "create" ? "Creating…" : `Create ${newSessionMode === "supervised" ? "manual" : "practice"} bench`}<span>→</span></button><small>Creating a session does not start a test or take a measurement.</small></div>}
                </div>
              </section>

              <section className="status-ribbon" aria-label="Service status">
                <StatusItem icon="◉" label="Bench service" value={health?.status === "ready" ? "Connected locally" : "Checking connection"} tone={health?.status === "ready" ? "good" : "muted"} />
                <StatusItem icon="✦" label="Reasoning" value={reasoningLabel} tone="muted" />
                <StatusItem icon="⌁" label="Voice" value={voiceOverviewLabel} tone="muted" />
                <StatusItem icon="⊘" label="Hardware" value={hardwareLabel} tone="locked" />
              </section>

              <section className="voice-card panel">
                <div className="voice-orb"><span>⌁</span><i /></div>
                <div className="voice-content">
                  <div className="voice-heading"><div><span className="eyebrow">LOCAL VOICE · PUSH TO TALK</span><h2>Talk through a question or reading</h2></div><span className={`voice-status ${["ready", "installed"].includes(voiceStatus?.status) ? "ready" : "unavailable"}`}><i />{voiceStatus?.status === "ready" ? `${voiceStatus.model ?? "Whisper"} ready` : voiceStatus?.status === "installed" ? `${voiceStatus.model ?? "Whisper"} · loads on demand` : voiceStatus?.status === "not_installed" ? "Speech model not installed" : "Checking local speech"}</span></div>
                  <p>Microphone access is requested only after you start. Audio is held in memory for up to 20 seconds, sent to local Whisper, then discarded.</p>
                  <div className="voice-controls">
                    {voiceState === "idle" && <button className="button voice-button" onClick={startPushToTalk} disabled={!sessionId || !["ready", "installed"].includes(voiceStatus?.status) || Boolean(busy)}><span className="mic-glyph">●</span>Start push-to-talk</button>}
                    {voiceState === "requesting" && <button className="button secondary" disabled><Spinner /> Waiting for microphone permission…</button>}
                    {voiceState === "recording" && <><span className="recording-pill"><i /> RECORDING · 00:{String(recordingSeconds).padStart(2, "0")}</span><button className="button primary" onClick={() => void stopPushToTalk(true)}>Finish & transcribe <span>→</span></button><button className="button secondary small" onClick={() => void stopPushToTalk(false)}>Discard</button></>}
                    {voiceState === "transcribing" && <span className="transcribing-state"><Spinner /> Transcribing locally…</span>}
                    {voiceStatus?.local_only && <span className="local-only-tag">LOCAL ONLY</span>}
                  </div>
                  {voiceStatus?.hands_free === "unverified" && <small className="voice-limit">Hands-free wake words are unverified and unavailable in this preview.</small>}
                  <details className="transcript-test"><summary>Test routing with typed text <span>NO MICROPHONE</span></summary><div className="transcript-test-row"><input value={transcriptTest} maxLength={4096} onChange={(event) => setTranscriptTest(event.target.value)} placeholder="Try: ‘I read 1.65 volts’ or ask a circuit question" /><button className="button secondary small" onClick={submitTranscriptTest} disabled={!sessionId || !transcriptTest.trim() || Boolean(busy)}>Route text</button></div></details>
                  {voiceReply?.route === "question" && voiceReply.result && <div className="voice-answer"><strong>Local evidence summary</strong><p>{voiceReply.result.text}</p><small>{voiceReply.result.evidence_ids?.length ? `Evidence: ${voiceReply.result.evidence_ids.join(", ")}` : "No supporting evidence IDs were returned."}{voiceReply.result.limitations?.length ? ` · ${voiceReply.result.limitations.join("; ")}` : ""}</small></div>}
                  {voiceReply?.route === "question" && (typeof voiceReply.question === "string" || typeof voiceReply.transcript?.text === "string") && <button className="text-button voice-investigate-button" onClick={() => { const originalQuestion = typeof voiceReply.question === "string" ? voiceReply.question : voiceReply.transcript.text; setInvestigatorPrefill(originalQuestion.slice(0, 4000)); setTab("troubleshoot"); }}>Investigate this question →</button>}
                  {voiceReply?.route === "question" && localSpeechEnabled && localVoice && typeof voiceReply.result?.text === "string" && <button className="button secondary small" onClick={() => speakLocalText(voiceReply.result.text)} disabled={voiceReply.result.text.length > 12000 || session?.status !== "active"}>{voiceReply.result.text.length > 12000 ? "Summary too long to read aloud" : `Read local summary · ${localVoice.name}`}</button>}
                  {voiceReply?.route && <div className="voice-route"><span>ROUTE</span> {niceName(voiceReply.route)}{voiceReply.transcript?.text ? <em>“{voiceReply.transcript.text}”</em> : null}</div>}
                </div>
              </section>

              {!session ? (
                <section className="welcome-card">
                  <div className="welcome-art"><GuidePortrait activity={activity} reducedMotion={reducedMotion} /></div>
                  <div className="welcome-copy">
                    <div className="eyebrow">A SAFE PLACE TO START</div>
                    <h2>Set up a bench session</h2>
                    <p>Choose a practice scenario or manual entry. Choosing a mode does not perform a test, activate an instrument, or take a reading.</p>
                    <label className="welcome-session-name"><span>SESSION NAME</span><input value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} maxLength={100} /></label>
                    <SessionModeOptions value={newSessionMode} onChange={setNewSessionMode} />
                    <div className="new-session-row"><button className="button primary" disabled={Boolean(busy)} onClick={createSession}>{busy === "create" ? "Creating…" : `Create ${newSessionMode === "supervised" ? "manual" : "practice"} bench`}<span>→</span></button></div>
                    {sessions.length > 0 && <div className="resume-row">Or resume an existing session from the selector above.</div>}
                  </div>
                </section>
              ) : (
                <>
                  <section className="workspace-grid">
                    <div className="panel circuit-panel">
                      <PanelHeader kicker="CIRCUIT MODEL" title={graphTitle} right={<span className="revision-tag">REV {session.revisions?.circuit_revision?.slice(0, 8) ?? "—"}</span>} />
                      <div className="fixture-row">
                        <div className="fixture-tabs" role="group" aria-label="Circuit fixture">
                          <button className={session.fixture === "divider" ? "active" : ""} onClick={() => switchFixture("divider")} disabled={Boolean(busy)}>Divider</button>
                          <button className={session.fixture === "loaded-divider" ? "active" : ""} onClick={() => switchFixture("loaded-divider")} disabled={Boolean(busy)}>Loaded</button>
                        </div>
                        <div className="circuit-import-actions"><span className={`fixture-tag ${session.fixture === "divider" || session.fixture === "loaded-divider" ? "" : "imported"}`}><i /> {session.fixture === "divider" || session.fixture === "loaded-divider" ? "CURATED FIXTURE" : "LOCAL IMPORT"}</span><button className="button secondary small import-circuit-button" onClick={importCircuit} disabled={!sessionId || Boolean(busy)}>{busy === "import" ? "Opening…" : "Import KiCad"}<span>↗</span></button></div>
                      </div>
                      <CircuitDiagram components={components} nodes={nodes} />
                      <p className="import-scope-note">KiCad import supports resistor and DC-source circuits. The file is chosen in a native dialog and validated locally.</p>
                      <div className="component-strip">
                        {components.map((part: AnyRecord) => <div className="component-chip" key={part.ref}><b>{part.ref}</b><span>{part.kind === "resistor" ? `${fmt(part.value_si >= 1000 ? part.value_si / 1000 : part.value_si)} ${part.value_si >= 1000 ? "kΩ" : "Ω"}` : `${fmt(part.value_si)} V`}</span></div>)}
                      </div>
                      <div className="panel-divider" />
                      <div className="simulation-row">
                        <div className="simulation-title"><span className="sim-icon">∿</span><div><strong>Operating point</strong><small>{latestSimulation ? `Source · ${latestSimulation.provenance === "ngspice_actual" ? "ngspice" : "unknown"}` : "No simulation run for this session"}</small></div></div>
                        <button className="button secondary small" onClick={runSimulation} disabled={!sessionId || Boolean(busy)}>{busy === "simulate" ? <Spinner /> : "Run local solve"}<span>↗</span></button>
                      </div>
                      {latestSimulation && <SimulationPanel result={latestSimulation} nodes={nodes} />}
                      <div className="diagnosis-panel">
                        <div className="diagnosis-topline"><div><span className="eyebrow">EVIDENCE REVIEW</span><strong>Compare hypotheses</strong><small>Uses the current local simulation and accepted session evidence.</small></div><button className="button secondary small" onClick={runDiagnosis} disabled={!sessionId || Boolean(busy)}>{busy === "diagnose" ? "Reviewing…" : diagnosis ? "Refresh" : "Diagnose"}<span>↗</span></button></div>
                        {!diagnosis ? <div className="diagnosis-empty">No diagnostic comparison for this session yet.</div> : <>
                          <div className="diagnosis-meta"><span>SIMULATION COMPARISON</span><span>REV {String(diagnosis.circuit_revision ?? "unknown").slice(0, 10)}</span></div>
                          {diagnosis.hypotheses?.length ? <div className="diagnosis-hypotheses">{diagnosis.hypotheses.map((item: AnyRecord) => <article className={`diagnosis-hypothesis ${item.status}`} key={item.id}><div className="diagnosis-hypothesis-head"><strong>{item.title}</strong><span>{niceName(String(item.status ?? "candidate"))} · score {fmt(item.score, 2)}</span></div>{item.predictions && <div className="diagnosis-predictions">{Object.entries(item.predictions).map(([node, value]) => <span key={node}>{node} <b>{fmt(value, 4)} V</b></span>)}</div>}</article>)}</div> : <p className="muted-copy">No competing hypotheses were returned.</p>}
                          {proposedTest && <div className="diagnosis-next-test"><span className="eyebrow">PROPOSED NEXT TEST · NOT STARTED</span><p>{proposedTest.reason}</p><div className="proposal-endpoints">Voltage · red {proposedTest.red_node_id} · black {proposedTest.black_node_id}</div><button className="button secondary small" onClick={() => useProposedTest(proposedTest)} disabled={!proposalReady}>Review in step setup <span>↓</span></button><small>{proposalReady ? "Saved low-voltage setup is present. Review the step and start it explicitly." : activeRequest ? "Finish or pause the existing step first." : "Save the low-voltage, current-limited setup declaration before using this proposal."}</small></div>}
                          {diagnosis.evidence_ids?.length > 0 && <div className="diagnosis-evidence">EVIDENCE · {diagnosis.evidence_ids.join(" · ")}</div>}
                          {diagnosis.limitations?.length > 0 && <div className="diagnosis-limitations">{diagnosis.limitations.map((limit: string, index: number) => <span key={index}>{limit}</span>)}</div>}
                        </>}
                      </div>
                    </div>

                    <div className="panel camera-panel">
                      <PanelHeader kicker="VISUAL CONTEXT" title="Camera views" right={<span className="offline-label"><i /> DISCONNECTED</span>} />
                      <div className="camera-placeholder">
                        <div className="camera-glyph"><span /><i /><b /></div>
                        <strong>No camera feed</strong>
                        <span>iPhone · Camo USB</span>
                        <small>Connect a camera in Devices when setup is ready.</small>
                      </div>
                      <div className="camera-placeholder camera-secondary">
                        <div className="camera-glyph pi"><span /><i /><b /></div>
                        <strong>Moving close-up</strong>
                        <span>Raspberry Pi camera · Ethernet</span>
                        <small>Not connected · physical output disabled</small>
                      </div>
                      <div className="semantic-demo"><div className="semantic-demo-top"><span>SEMANTIC OVERLAY PREVIEW</span><span className="mock-tag">ILLUSTRATION</span></div><div className="overlay-sketch"><span className="target-ring">A</span><span className="target-line" /><span className="target-point" /><small>Test point · A</small></div><p>Illustrated target marker. No live image or camera coordinates.</p></div>
                    </div>
                  </section>

                  <section className="panel workflow-panel">
                    <PanelHeader kicker={isManualSession ? "MANUAL READING" : "GUIDED CHECK"} title={isManualSession ? "Prepare a reading request" : "Choose a measurement step"} right={<span className={`session-state ${session.status}`}>{session.status === "active" ? (isManualSession ? "● Ready to record" : "● Ready for practice") : "Ⅱ Paused"}</span>} />
                    {activeRequest ? (
                      <div className="pending-step">
                        <div className="step-number">01</div>
                        <div className="pending-content">
                          <div className="pending-title"><div><span className="eyebrow">{isManualSession ? "MANUAL READING REQUEST" : "PRACTICE READING REQUEST"}</span><h3>{niceName(activeRequest.quantity)} · {activeRequest.meter_mode.replaceAll("_", " ")}</h3></div><button className="text-button" onClick={pauseSession} disabled={Boolean(busy)}>Cancel & pause</button></div>
                          <div className="probe-instructions"><ProbeMark color="red" /> Red probe on <strong>{activeRequest.red_node_id}</strong><span className="probe-separator">·</span><ProbeMark color="black" /> Black probe on <strong>{activeRequest.black_node_id}</strong></div>
                          <div className="candidate-entry"><label htmlFor="reading-entry">{isManualSession ? "READING YOU OBSERVED ON YOUR METER" : "READING FROM YOUR DISPLAY OR PRACTICE SCENARIO"}</label><div className="candidate-input-row"><input id="reading-entry" value={readingText} onChange={(event) => setReadingText(event.target.value)} placeholder="e.g. 1.65 V or OL" maxLength={4096} /><button className="button primary" onClick={submitCandidate} disabled={Boolean(busy) || !readingText.trim()}>{busy === "candidate" ? <Spinner /> : candidate ? "Replace candidate" : "Read back"}<span>→</span></button></div><small>{candidate ? "Submitting another value replaces this pending candidate and readback." : isManualSession ? "Type the value you observed. Confirmation records your report; Ohm Path cannot see or verify the instrument." : "Entering text creates a candidate. It does not confirm a measurement."}</small><div className="meter-ocr-row"><button className="button secondary small" onClick={readSelectedMeterImage} disabled={Boolean(busy)}>{busy === "meter-image" ? "Preparing image…" : "Read selected meter image · optional, experimental"}</button><small>Select an existing, cropped image in the native file picker. Raw camera frames are not inspected or saved; local OCR may be unavailable.</small></div></div>
                          {candidate && <div className="candidate-card"><div className="candidate-icon">{candidate.display_state === "numeric" ? "↗" : "?"}</div><div className="candidate-info"><span className="eyebrow">PENDING CANDIDATE · {candidate.source}</span><strong>{candidate.value !== null ? `${candidate.value} ${candidate.si_unit ?? ""}` : candidate.display_state === "over_limit" ? "Over limit · OL" : "Needs clarification"}</strong><small>Original: “{candidate.original_text}”{candidate.ambiguities?.length ? ` · ${candidate.ambiguities.join(", ")}` : ""}</small></div>{candidate.display_state !== "unknown" && candidate.display_state !== "unstable" && <div className="candidate-state">AWAITING YOU</div>}</div>}
                    {confirmation && <div className="readback-card"><div className="readback-label"><span className="readback-wave">〰</span><div><span className="eyebrow">CHECK THIS READBACK</span><p>{confirmation.readback_text}</p></div></div><div className="readback-actions">{localSpeechEnabled && localVoice && <button className="button secondary small" onClick={speakReadback} disabled={Boolean(busy)}>Read aloud · {localVoice.name}</button>}<button className="button secondary small" onClick={acknowledgeReadback} disabled={Boolean(busy) || readbackAcknowledged}>{readbackAcknowledged ? "Readback checked ✓" : "I checked this readback"}</button><button className="button confirm-button small" onClick={confirmCandidate} disabled={!readbackAcknowledged || Boolean(busy)}>{isManualSession ? "Confirm my reported reading" : "Confirm practice input"}<span>✓</span></button></div>{isManualSession && <small className="manual-provenance-note">Your confirmation records a user-reported physical measurement. It is not automatically verified.</small>}{correctableEvents.length > 0 && <label className="correction-select">CORRECTING A PREVIOUS ENTRY? <select value={correctionEvent} onChange={(event) => setCorrectionEvent(event.target.value)}><option value="">No correction</option>{correctableEvents.map((event) => <option key={event.event_id} value={event.event_id}>{event.payload?.candidate?.value ?? "OL"} {event.payload?.candidate?.si_unit ?? ""} · event {event.event_id.slice(0, 8)}</option>)}</select></label>}</div>}
                        </div>
                      </div>
                    ) : (
                      <div className="measurement-setup">
                        <div className="measurement-fields">
                          <Field label="WHAT ARE YOU CHECKING?"><select value={quantity} onChange={(event) => chooseQuantity(event.target.value)}><option value="voltage">Voltage</option><option value="resistance">Resistance</option><option value="continuity">Continuity</option></select></Field>
                          <Field label="METER MODE"><select value={meterMode} onChange={(event) => setMeterMode(event.target.value)}>{quantity === "voltage" ? <><option value="DC_voltage">DC voltage</option><option value="AC_voltage">AC voltage</option></> : <option value={quantity}>{niceName(quantity)}</option>}</select></Field>
                          <Field label="RED PROBE · NODE"><select value={redNode} onChange={(event) => setRedNode(event.target.value)}>{nodes.map((node: string) => <option key={node} value={node}>{node}</option>)}</select></Field>
                          <Field label="BLACK PROBE · NODE"><select value={blackNode} onChange={(event) => setBlackNode(event.target.value)}>{nodes.map((node: string) => <option key={node} value={node}>{node}</option>)}</select></Field>
                        </div>
                        <div className="setup-section">
                          <div className="setup-heading"><div><span className="eyebrow">BEFORE YOU BEGIN</span><h3>Bench setup</h3></div><span className="practice-only-mini">{isManualSession ? "Your declarations · unverified" : "Practice declarations"}</span></div>
                          <div className="power-options"><button className={setupPower === "on_current_limited" ? "active" : ""} onClick={() => setSetupPower("on_current_limited")}><span className="power-dot on" /><span><b>Low-voltage supply</b><small>{isManualSession ? "User declaration · not verified" : "Current limited · practice declaration"}</small></span></button><button className={setupPower === "off_verified" ? "active" : ""} onClick={() => setSetupPower("off_verified")}><span className="power-dot off" /><span><b>Supply off</b><small>For resistance or continuity</small></span></button><button className={setupPower === "unknown" ? "active" : ""} onClick={() => setSetupPower("unknown")}><span className="power-dot unknown" /><span><b>Unknown</b><small>Keep tests locked</small></span></button></div>
                          {setupPower === "on_current_limited" && <label className="single-check"><input type="checkbox" checked={checks.low_voltage_confirmed === true} onChange={(event) => setChecks((prior) => ({ ...prior, low_voltage_confirmed: event.target.checked }))} /><span>{isManualSession ? "I declare this is a low-voltage, current-limited setup. Ohm Path has not verified it." : "I declare this is a low-voltage, current-limited practice setup."}</span></label>}
                          {setupPower === "off_verified" && <div className="check-grid">{safeChecks.map(([key, label]) => <label key={key} className="single-check"><input type="checkbox" checked={checks[key] === true} onChange={(event) => setChecks((prior) => ({ ...prior, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div>}
                          <div className="setup-footer"><span className={setupReady && setupSaved ? "ready-copy" : "blocked-copy"}>{!setupReady ? "Complete the relevant checks to unlock this reading step" : setupSaved ? "Saved declarations · ready to request" : "Save these setup declarations before starting"}</span><div className="setup-buttons"><button className="button secondary small" onClick={saveSetup} disabled={Boolean(busy)}>{busy === "setup" ? "Saving…" : "Save setup"}</button><button className="button primary" onClick={requestTest} disabled={!canMeasure || !setupReady || !setupSaved || Boolean(busy)}>{busy === "request" ? <Spinner /> : isManualSession ? "Prepare reading request" : "Start practice step"}<span>→</span></button></div></div>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="lower-grid">
                    <div className="panel ledger-panel"><PanelHeader kicker="SESSION HISTORY" title="Evidence ledger" right={<span className="revision-tag">{events.length} EVENTS</span>} /><div className="ledger-list">{events.length === 0 ? <div className="empty-ledger">No session events yet. {isManualSession ? "Prepare a reading request when you are ready." : "Start a practice reading step to see its record here."}</div> : events.slice().reverse().slice(0, 8).map((event) => <LedgerEvent key={event.event_id} event={event} />)}</div></div>
                    <div className="panel guide-panel"><div className="guide-panel-art"><GuidePortrait activity={activity} reducedMotion={reducedMotion} compact /></div><div className="guide-panel-copy"><span className="eyebrow">YOUR BENCH GUIDE</span><h3>Ohm Path guide</h3><p>Neutral placeholder guide. The Frieren character, licensed assets, and voice are still pending.</p><span className={`guide-activity ${activity}`}><i />{activityLabel[activity]}</span><button className="text-button" onClick={() => setTab("settings")}>Guide registry →</button></div></div>
                  </section>
                </>
              )}

              {(error || notice) && <div className={`toast ${error ? "error" : "success"}`} role="status"><span>{error ? "!" : "✓"}</span><div><strong>{error ? "Needs attention" : "Updated"}</strong><small>{error || notice}</small></div><button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss">×</button></div>}
            </>
          ) : <ComingSoon tab={tab} onBack={() => setTab("bench")} />}
        </div>
        <footer className="app-footer"><span>Ohm Path · {isManualSession ? "Manual user-reported entry" : "Local practice environment"}</span><span>Visual guidance is not electrical verification.</span></footer>
      </main>

      {showGuide && <aside className="guide-float" aria-label="Guide companion"><div className="guide-float-head"><span className="guide-mini-dot" /><span>GUIDE COMPANION</span><button onClick={() => setShowGuide(false)} aria-label="Hide guide">×</button></div><div className="guide-float-body"><GuidePortrait activity={activity} reducedMotion={reducedMotion} compact /><div><strong>{isManualSession ? "Bench companion" : "Practice together"}</strong><small>{activityLabel[activity]}</small></div></div></aside>}
    </div>
  );
}

function StatusItem({ icon, label, value, tone }: { icon: string; label: string; value: string; tone: string }) {
  return <div className="status-item"><span className={`status-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function PanelHeader({ kicker, title, right }: { kicker: string; title: string; right?: ReactNode }) {
  return <div className="panel-header"><div><span className="eyebrow">{kicker}</span><h2>{title}</h2></div>{right}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function SessionModeOptions({ value, onChange }: { value: "mock" | "supervised"; onChange: (mode: "mock" | "supervised") => void }) {
  return <fieldset className="session-mode-options">
    <legend>HOW WILL YOU ENTER READINGS?</legend>
    <label className={value === "mock" ? "selected" : ""}><input type="radio" name="session-mode" value="mock" checked={value === "mock"} onChange={() => onChange("mock")} /><span><strong>Practice scenario</strong><small>Mock input · confirmed values are labeled simulated.</small></span></label>
    <label className={value === "supervised" ? "selected" : ""}><input type="radio" name="session-mode" value="supervised" checked={value === "supervised"} onChange={() => onChange("supervised")} /><span><strong>Manual bench</strong><small>Record your own readings; physical output remains disabled.</small></span></label>
  </fieldset>;
}

function ProbeMark({ color }: { color: "red" | "black" }) {
  return <span className={`probe-mark ${color}`} aria-hidden="true"><i /></span>;
}

function Spinner() { return <span className="spinner" aria-label="Working" />; }

function CircuitDiagram({ components, nodes }: { components: AnyRecord[]; nodes: string[] }) {
  if (!components.length) return <div className="diagram-empty">Circuit graph is loading…</div>;
  const width = Math.max(660, 210 + Math.max(1, nodes.length - 1) * 82);
  const rowHeight = 46;
  const height = components.length * rowHeight + 28;
  const nodeIndex = new Map(nodes.map((node, index) => [node, index]));
  const nodeRows = new Map<string, number[]>();
  components.forEach((part, index) => (part.nodes ?? []).forEach((node: string) => nodeRows.set(node, [...(nodeRows.get(node) ?? []), index])));
  const nodeX = (node: string) => 134 + (nodeIndex.get(node) ?? 0) * 82;
  return <div className="circuit-diagram"><svg style={{ minWidth: `${width}px` }} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Circuit component and connected-node diagram">
    <defs><linearGradient id="trace" x1="0" x2="1"><stop stopColor="#1bc7b0" stopOpacity=".34" /><stop offset="1" stopColor="#6ed6cb" stopOpacity=".8" /></linearGradient></defs>
    {[...nodeRows.entries()].map(([node, rows]) => rows.length > 1 && <path key={`bus-${node}`} d={`M ${nodeX(node)} ${20 + Math.min(...rows) * rowHeight} V ${20 + Math.max(...rows) * rowHeight}`} className="trace node-bus" />)}
    {components.map((part, index) => {
      const y = 20 + index * rowHeight;
      const partNodes = Array.isArray(part.nodes) ? part.nodes : [];
      if (partNodes.length < 2) return <g key={part.ref ?? index}><text x="12" y={y + 4} className="part-ref">{part.ref ?? "?"}</text><text x="52" y={y + 4} className="part-value">Missing node endpoints</text></g>;
      const leftX = nodeX(partNodes[0]);
      const rightX = nodeX(partNodes[1]);
      const x1 = Math.min(leftX, rightX);
      const x2 = Math.max(leftX, rightX);
      const center = (x1 + x2) / 2;
      const reversed = leftX > rightX;
      return <g key={part.ref} className="diagram-row">
        <text x="12" y={y + 4} className="part-ref">{part.ref}</text>
        <text x="52" y={y + 4} className="part-value">{part.kind === "resistor" ? `${fmt(part.value_si >= 1000 ? part.value_si / 1000 : part.value_si)}${part.value_si >= 1000 ? " kΩ" : " Ω"}` : `${fmt(part.value_si)} V`}</text>
        <path d={`M ${x1} ${y} H ${center - 32}`} className="trace" />
        {part.kind === "resistor" ? <path d={`M ${center - 32} ${y} l 8 -8 9 16 9 -16 9 16 9 -16 8 8`} className="resistor-symbol" /> : <g><circle cx={center} cy={y} r="18" className="source-symbol" /><text x={center} y={y + 5} className="source-sign">＋</text></g>}
        <path d={`M ${center + 32} ${y} H ${x2}`} className="trace" />
        <circle cx={leftX} cy={y} r="3.5" className="node-dot" /><circle cx={rightX} cy={y} r="3.5" className="node-dot" />
        <text x={leftX} y={y - 10} textAnchor="middle" className="node-label">{part.nodes[0]}</text>
        <text x={rightX} y={y - 10} textAnchor="middle" className="node-label">{part.nodes[1]}</text>
        {reversed && <title>{part.ref}: {part.nodes[0]} to {part.nodes[1]}</title>}
      </g>;
    })}
  </svg></div>;
}

function SimulationPanel({ result, nodes }: { result: AnyRecord; nodes: string[] }) {
  const succeeded = result?.status === "succeeded";
  return <div className={`simulation-result ${succeeded ? "succeeded" : "failed"}`}>
    <div className="simulation-result-head"><span className={`result-dot ${succeeded ? "good" : "bad"}`} /><strong>{succeeded ? "Solver completed" : "No successful solver result"}</strong><span>{result?.provenance === "ngspice_actual" ? "ACTUAL NGSPICE RUN" : "SOLVER STATUS"}</span></div>
    {succeeded ? <div className="voltage-grid">{nodes.map((node) => <div className="voltage-cell" key={node}><small>{node}</small><strong>{node === "GND" ? "0" : fmt(result.node_voltages_v?.[node], 4)}<em>V</em></strong></div>)}</div> : <p>{result?.error || result?.stderr || "The run failed or is unavailable."}</p>}
    {succeeded && <small className="sim-proof">Duration {fmt(result.duration_s, 2)} s · graph {String(result.graph_sha256 ?? "").slice(0, 12)}</small>}
  </div>;
}

function LedgerEvent({ event }: { event: AnyRecord }) {
  const payload = event.payload ?? {};
  const confirmedCandidate = payload.candidate;
  const simulation = event.event_type === "simulation.finished" ? payload : null;
  const title = event.event_type === "measurement.confirmed"
    ? `Reading confirmed · ${confirmedCandidate?.value ?? "OL"} ${confirmedCandidate?.si_unit ?? ""}`
    : event.event_type === "simulation.finished"
      ? `Simulation ${simulation?.status ?? "recorded"}`
      : niceName(event.event_type.replaceAll(".", " "));
  const provenance = payload.evidence_kind === "simulated_user_input" ? "SIMULATED USER INPUT" : payload.evidence_kind === "user_reported_physical_measurement" ? "USER-REPORTED PHYSICAL" : simulation?.provenance === "ngspice_actual" ? "ACTUAL NGSPICE" : event.source?.toUpperCase() ?? "BENCH";
  const tone = payload.evidence_kind === "simulated_user_input" ? "practice" : simulation?.status === "failed" ? "failed" : "normal";
  return <div className="ledger-event"><span className={`ledger-mark ${tone}`}>{event.event_type === "simulation.finished" ? "∿" : event.event_type === "measurement.confirmed" ? "✓" : "·"}</span><div className="ledger-event-main"><strong>{title}</strong><small>#{String(event.sequence).padStart(3, "0")} · {new Date(event.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div><span className={`provenance-tag ${tone}`}>{provenance}</span></div>;
}

function GuidePortrait({ activity, reducedMotion, compact = false }: { activity: GuideActivity; reducedMotion: boolean; compact?: boolean }) {
  return <div className={`guide-portrait ${compact ? "compact" : ""} ${activity} ${reducedMotion ? "static" : ""}`} aria-hidden="true">
    <span className="portrait-aura" /><span className="portrait-hair hair-back" /><span className="portrait-neck" /><span className="portrait-shoulder" /><span className="portrait-face"><i className="eye left" /><i className="eye right" /><i className="face-blush left" /><i className="face-blush right" /><i className="mouth" /></span><span className="portrait-hair hair-front" /><span className="portrait-star star-one">✦</span><span className="portrait-star star-two">·</span>
  </div>;
}

function ComingSoon({ tab, onBack }: { tab: Tab; onBack: () => void }) {
  const title = niceName(tab);
  return <section className="coming-soon panel"><div className="coming-orbit"><span>Ω</span><i /><b /></div><span className="eyebrow">WORKSPACE MODULE</span><h1>{title}</h1><p>This area is reserved for {title.toLowerCase()} tools. This preview only shows features backed by the current local service.</p><div className="coming-status"><span /> NO CAPABILITY CLAIMED</div><button className="button secondary" onClick={onBack}>Return to practice bench <span>←</span></button></section>;
}

function SettingsPage({ reducedMotion, onReducedMotion, showGuide, onShowGuide, localSpeechEnabled, onLocalSpeech, localVoice, voiceStatus, reasoningStatus, companionEnabled, companionBusy, companionError, onCompanion }: {
  reducedMotion: boolean;
  onReducedMotion: (value: boolean) => void;
  showGuide: boolean;
  onShowGuide: (value: boolean) => void;
  localSpeechEnabled: boolean;
  onLocalSpeech: (value: boolean) => void;
  localVoice: SpeechSynthesisVoice | null;
  voiceStatus: AnyRecord | null;
  reasoningStatus?: string;
  companionEnabled: boolean;
  companionBusy: boolean;
  companionError: string;
  onCompanion: (enabled: boolean) => void;
}) {
  return <div className="settings-page">
    <div className="page-heading settings-heading"><div><div className="eyebrow">PREFERENCES & REGISTRY</div><h1>Settings</h1><p>Local display preferences and the guide slots planned for Ohm Path.</p></div></div>
    <div className="settings-grid">
      <ElevenLabsSettings />
      <section className="panel settings-panel"><PanelHeader kicker="ACCESSIBILITY" title="Display preferences" />
        <label className="preference-row"><span><strong>Reduce motion</strong><small>Stop decorative animation across the guide and interface.</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => onReducedMotion(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>Show guide companion</strong><small>Keep the small guide panel visible above the work area.</small></span><input type="checkbox" checked={showGuide} onChange={(event) => onShowGuide(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>Optional local system voice</strong><small>{localVoice ? `System voice: ${localVoice.name}. Spoken summaries and explanations require a button press.` : "No local system voice is available. Captions remain available."}</small></span><input type="checkbox" checked={localSpeechEnabled} disabled={!localVoice} onChange={(event) => onLocalSpeech(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>Floating desktop companion</strong><small>Open a separate activity and caption window. It has no bench controls and opens only when enabled.</small></span><input type="checkbox" checked={companionEnabled} disabled={companionBusy} onChange={(event) => onCompanion(event.target.checked)} /></label>
        {companionError && <p className="companion-settings-error" role="alert">{companionError}</p>}
      </section>
      <section className="panel settings-panel registry-panel"><PanelHeader kicker="CHARACTER REGISTRY" title="Guides" right={<span className="revision-tag">3 PLANNED SLOTS</span>} />
        <div className="registry-entry"><span className="registry-avatar pending">F</span><span><strong>Frieren</strong><small>Selected for first guide · character art and voice not supplied</small></span><span className="registry-status pending">PENDING ASSETS</span></div>
        <div className="registry-entry"><span className="registry-avatar">02</span><span><strong>Guide slot 2</strong><small>No character selected</small></span><span className="registry-status">OPEN</span></div>
        <div className="registry-entry"><span className="registry-avatar">03</span><span><strong>Guide slot 3</strong><small>No character selected</small></span><span className="registry-status">OPEN</span></div>
        <p className="registry-note">This preview uses a neutral abstract placeholder. It does not represent an approved Frieren asset or licensed voice.</p>
      </section>
      <section className="panel settings-panel runtime-panel"><PanelHeader kicker="RUNTIME BOUNDARIES" title="Connected services" />
        <div className="runtime-row"><span><strong>Reasoning</strong><small>{reasoningStatus === "subscription_on_request" ? "Subscription route; account and allowance checks run before each request." : "Preflight status is not currently available."}</small></span><span className={`runtime-state ${reasoningStatus === "subscription_on_request" ? "safe" : "paused"}`}>{reasoningStatus === "subscription_on_request" ? "ON REQUEST" : "UNAVAILABLE"}</span></div>
        <div className="runtime-row"><span><strong>Local speech recognition</strong><small>whisper.cpp · {voiceStatus?.model ?? "small.en"} · microphone is user-controlled and currently off.</small></span><span className={`runtime-state ${["ready", "installed"].includes(voiceStatus?.status) ? "safe" : "paused"}`}>{voiceStatus?.status?.toUpperCase() ?? "CHECKING"}</span></div>
        <div className="runtime-row"><span><strong>ElevenLabs voice</strong><small>Account linking is above. Speech generation remains disabled during setup.</small></span><span className="runtime-state">SPEECH OFF</span></div>
        <div className="runtime-row"><span><strong>Paid fallback</strong><small>Automatic paid or model downgrade is not enabled.</small></span><span className="runtime-state safe">OFF</span></div>
        <div className="runtime-row"><span><strong>Physical output</strong><small>Laser and motion remain disabled.</small></span><span className="runtime-state paused">LOCKED</span></div>
      </section>
    </div>
  </div>;
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

function resample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function pcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export default App;
