import { useEffect, useRef, useState } from "react";

type RecordLike = Record<string, any>;

async function action<T = any>(name: string, payload: Record<string, unknown>): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("The local bench connection is unavailable.");
  const response = await window.ohmpath.request(name, payload);
  if (response && typeof response === "object" && "error" in response) {
    const result = response as RecordLike;
    throw new Error(result.message || String(result.error));
  }
  return response as T;
}

function plainAnswer(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as RecordLike;
    if (typeof record.text === "string") return record.text;
    if (typeof record.answer === "string") return record.answer;
    return JSON.stringify(value, null, 2);
  }
  return value == null ? "No answer text was returned." : String(value);
}

export default function TroubleshootPage({ sessionId, circuitRevision, contextEpoch, prefillQuestion = "", onPrefillConsumed, localSpeechAvailable = false, onReadAloud, onStopSpeaking }: {
  sessionId: string;
  circuitRevision: string;
  contextEpoch: string;
  prefillQuestion?: string;
  onPrefillConsumed?: () => void;
  localSpeechAvailable?: boolean;
  onReadAloud?: (text: unknown) => void;
  onStopSpeaking?: () => void;
}) {
  const [assembly, setAssembly] = useState<RecordLike | null>(null);
  const [assemblyBusy, setAssemblyBusy] = useState(false);
  const [assemblyError, setAssemblyError] = useState("");
  const [stepChecks, setStepChecks] = useState<Record<string, boolean>>({});

  const [logText, setLogText] = useState("");
  const [board, setBoard] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [firmware, setFirmware] = useState<RecordLike | null>(null);
  const [firmwareBusy, setFirmwareBusy] = useState(false);
  const [firmwareError, setFirmwareError] = useState("");

  const [question, setQuestion] = useState("");
  const [investigation, setInvestigation] = useState<RecordLike | null>(null);
  const [investigationBusy, setInvestigationBusy] = useState(false);
  const [investigationError, setInvestigationError] = useState("");
  const mountedRef = useRef(true);
  const contextRef = useRef({ sessionId, circuitRevision, contextEpoch, version: 0 });
  if (contextRef.current.sessionId !== sessionId || contextRef.current.circuitRevision !== circuitRevision || contextRef.current.contextEpoch !== contextEpoch) {
    contextRef.current = { sessionId, circuitRevision, contextEpoch, version: contextRef.current.version + 1 };
  }
  const assemblyRequestRef = useRef(0);
  const firmwareRequestRef = useRef(0);
  const investigationRequestRef = useRef(0);
  const current = (version: number, request: number, activeRequest: { current: number }) =>
    mountedRef.current && contextRef.current.version === version && activeRequest.current === request;
  const turnRef = useRef<{ session_id: string; turn_id: string } | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      assemblyRequestRef.current += 1;
      firmwareRequestRef.current += 1;
      investigationRequestRef.current += 1;
      onStopSpeaking?.();
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
      const turn = turnRef.current;
      turnRef.current = null;
      if (turn) void action("investigateCancel", { sid: turn.session_id, turn_id: turn.turn_id }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    assemblyRequestRef.current += 1;
    firmwareRequestRef.current += 1;
    investigationRequestRef.current += 1;
    const previousTurn = turnRef.current;
    onStopSpeaking?.();
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    turnRef.current = null;
    if (previousTurn) void action("investigateCancel", { sid: previousTurn.session_id, turn_id: previousTurn.turn_id }).catch(() => undefined);
    setAssemblyBusy(false);
    setFirmwareBusy(false);
    setInvestigationBusy(false);
    setAssemblyError("");
    setFirmwareError("");
    setInvestigationError("");
    setAssembly(null);
    setStepChecks({});
    setFirmware(null);
    setInvestigation(null);
    setQuestion("");
  }, [sessionId, circuitRevision, contextEpoch]);

  useEffect(() => {
    if (!prefillQuestion) return;
    setQuestion(prefillQuestion.slice(0, 4000));
    onPrefillConsumed?.();
  }, [prefillQuestion]);

  async function loadAssemblyPlan() {
    if (!sessionId) return;
    const version = contextRef.current.version;
    const request = ++assemblyRequestRef.current;
    setAssemblyBusy(true);
    setAssemblyError("");
    try {
      const result = await action<RecordLike>("assemblyPlan", { sid: sessionId });
      if (!current(version, request, assemblyRequestRef)) return;
      setAssembly(result);
      setStepChecks({});
    } catch (problem) {
      if (current(version, request, assemblyRequestRef)) setAssemblyError(problem instanceof Error ? problem.message : "The assembly guide could not be loaded.");
    } finally { if (current(version, request, assemblyRequestRef)) setAssemblyBusy(false); }
  }

  async function analyzeFirmware() {
    if (!sessionId || !logText.trim()) return;
    const version = contextRef.current.version;
    const request = ++firmwareRequestRef.current;
    setFirmwareBusy(true);
    setFirmwareError("");
    try {
      const result = await action<RecordLike>("firmwareAnalyze", {
        sid: sessionId, log_text: logText,
        ...(board.trim() ? { board: board.trim() } : {}),
        ...(baudRate ? { baud_rate: baudRate } : {}),
      });
      if (!current(version, request, firmwareRequestRef)) return;
      setFirmware(result);
    } catch (problem) {
      if (current(version, request, firmwareRequestRef)) setFirmwareError(problem instanceof Error ? problem.message : "The supplied log could not be analyzed.");
    } finally { if (current(version, request, firmwareRequestRef)) setFirmwareBusy(false); }
  }

  function invalidateFirmwareInput() {
    firmwareRequestRef.current += 1;
    setFirmwareBusy(false);
    setFirmware(null);
    setFirmwareError("");
  }

  async function pollTurn(session_id: string, turn_id: string, version: number, request: number) {
    try {
      const status = await action<RecordLike>("investigateStatus", { sid: session_id, turn_id });
      if (!current(version, request, investigationRequestRef) || turnRef.current?.turn_id !== turn_id) return;
      setInvestigation(status);
      if (status.status === "running") {
        pollTimerRef.current = window.setTimeout(() => { void pollTurn(session_id, turn_id, version, request); }, 900);
      } else {
        turnRef.current = null;
        setInvestigationBusy(false);
      }
    } catch (problem) {
      if (!current(version, request, investigationRequestRef) || turnRef.current?.turn_id !== turn_id) return;
      turnRef.current = null;
      setInvestigationBusy(false);
      setInvestigationError(problem instanceof Error ? problem.message : "Could not retrieve investigation status.");
    }
  }

  async function askInvestigator(attachImage = false) {
    if (!sessionId || !question.trim() || investigationBusy) return;
    const version = contextRef.current.version;
    const request = ++investigationRequestRef.current;
    setInvestigationBusy(true);
    setInvestigationError("");
    setInvestigation(null);
    try {
      const started = await action<RecordLike>(attachImage ? "investigateWithImage" : "investigateStart", { sid: sessionId, question: question.trim().slice(0, 4000) });
      if (!current(version, request, investigationRequestRef)) {
        if (started.turn_id) void action("investigateCancel", { sid: sessionId, turn_id: started.turn_id }).catch(() => undefined);
        return;
      }
      if (started.cancelled) { setInvestigationBusy(false); return; }
      if (!started.turn_id) throw new Error("The investigation did not return a turn ID.");
      turnRef.current = { session_id: sessionId, turn_id: started.turn_id };
      setInvestigation(started);
      if (started.status === "running") pollTimerRef.current = window.setTimeout(() => { void pollTurn(sessionId, started.turn_id, version, request); }, 450);
      else { turnRef.current = null; setInvestigationBusy(false); }
    } catch (problem) {
      if (!current(version, request, investigationRequestRef)) return;
      setInvestigationBusy(false);
      setInvestigationError(problem instanceof Error ? problem.message : "Could not start the investigation.");
    }
  }

  async function cancelInvestigation() {
    const turn = turnRef.current;
    const version = contextRef.current.version;
    const request = ++investigationRequestRef.current;
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    turnRef.current = null;
    setInvestigationError("");
    setInvestigationBusy(false);
    setInvestigation({ status: "cancelled", message: "This turn was cancelled." });
    if (!turn) return;
    try {
      const result = await action<RecordLike>("investigateCancel", { sid: turn.session_id, turn_id: turn.turn_id });
      if (current(version, request, investigationRequestRef)) setInvestigation(result);
    } catch (problem) {
      if (current(version, request, investigationRequestRef)) setInvestigationError(problem instanceof Error ? problem.message : "The investigation could not be cancelled.");
    }
  }

  const steps = assembly?.steps ?? [];
  const observations = firmware?.observations ?? [];
  const hypotheses = firmware?.hypotheses ?? [];
  const answer = investigation?.answer;

  return <div className="troubleshoot-page">
    <div className="page-heading"><div><div className="eyebrow">READ-ONLY GUIDANCE</div><h1>Troubleshoot</h1><p>Assembly steps, user-supplied firmware logs, and evidence-grounded questions. Physical verification stays with you.</p></div><span className="practice-pill"><i /> SESSION {sessionId ? sessionId.slice(0, 8) : "NOT SELECTED"}</span></div>
    {!sessionId && <div className="inline-error">Choose or create a practice session before using troubleshooting tools.</div>}

    <section className="panel troubleshooting-panel assembly-guide-panel">
      <div className="troubleshoot-heading"><div><span className="eyebrow">ASSEMBLY GUIDE</span><h2>Step-by-step circuit guidance</h2><p>Based on the selected circuit fixture. Ohm Path does not sense completed wiring.</p></div><button className="button secondary" onClick={loadAssemblyPlan} disabled={!sessionId || assemblyBusy}>{assemblyBusy ? "Preparing guide…" : assembly ? "Refresh plan" : "Prepare assembly plan"}<span>↗</span></button></div>
      {!assembly ? <div className="module-empty"><span>▦</span><strong>No assembly steps loaded</strong><small>Request a plan to see component and node references for the current circuit.</small></div> : <>
        <div className="verification-banner"><span className="pending-mark">!</span><div><strong>Physical verification pending</strong><small>Every checkbox below is only your report. No camera or continuity check verifies the assembly.</small></div><span className="pending-chip">{assembly.physical_verification ?? "pending"}</span></div>
        <div className="assembly-steps">{steps.map((step: RecordLike, index: number) => <article className={`assembly-step ${stepChecks[step.step_id] ? "user-checked" : ""}`} key={step.step_id}>
          <div className="assembly-step-number">{String(index + 1).padStart(2, "0")}</div>
          <div className="assembly-step-main"><div className="assembly-step-title"><h3>{step.title}</h3>{step.requires_unpowered && <span className="unpowered-chip">POWER OFF REQUIRED</span>}</div><p>{step.instruction}</p><div className="assembly-refs">{step.component_ids?.length > 0 && <span>COMPONENTS <b>{step.component_ids.join(" · ")}</b></span>}{step.node_ids?.length > 0 && <span>NODES <b>{step.node_ids.join(" · ")}</b></span>}</div>
            <label className="step-user-check"><input type="checkbox" checked={stepChecks[step.step_id] === true} onChange={(event) => setStepChecks((prior) => ({ ...prior, [step.step_id]: event.target.checked }))} /><span>{stepChecks[step.step_id] ? "You marked this step checked" : "I checked this step myself"}</span><small>{stepChecks[step.step_id] ? "User-reported · not instrument verified" : "Pending your check"}</small></label>
          </div>
          <div className="step-pending-label">{stepChecks[step.step_id] ? "SELF-REPORTED" : "PENDING"}</div>
        </article>)}</div>
        <div className="assembly-footer"><span>{steps.filter((step: RecordLike) => stepChecks[step.step_id]).length} of {steps.length} steps marked by you</span><span>Physical verification: pending</span></div>
      </>}
      {assemblyError && <div className="inline-error">{assemblyError}</div>}
    </section>

    <div className="troubleshoot-two-col">
      <section className="panel troubleshooting-panel firmware-panel">
        <div className="troubleshoot-heading"><div><span className="eyebrow">FIRMWARE LOG REVIEW</span><h2>Share a serial or build log</h2><p>Analysis is read-only and limited to text you provide here.</p></div><span className="readonly-stamp">READ ONLY</span></div>
        <div className="firmware-fields"><label><span>BOARD (OPTIONAL)</span><input value={board} onChange={(event) => { invalidateFirmwareInput(); setBoard(event.target.value); }} maxLength={80} placeholder="e.g. Arduino Uno" /></label><label><span>BAUD RATE</span><select value={baudRate} onChange={(event) => { invalidateFirmwareInput(); setBaudRate(Number(event.target.value)); }}><option value={9600}>9600</option><option value={57600}>57600</option><option value={115200}>115200</option><option value={230400}>230400</option></select></label></div>
        <label className="firmware-log-field"><span>PASTE LOG TEXT · MAX 20,000 CHARACTERS</span><textarea value={logText} maxLength={20000} onChange={(event) => { invalidateFirmwareInput(); setLogText(event.target.value); }} placeholder="Paste the text you copied from your serial monitor or build output…" /></label>
        <div className="firmware-submit-row"><small>Ohm Path will not connect to a board, run commands, or flash firmware.</small><button className="button primary" onClick={analyzeFirmware} disabled={!sessionId || !logText.trim() || firmwareBusy}>{firmwareBusy ? "Reviewing text…" : "Analyze supplied log"}<span>→</span></button></div>
        {firmwareError && <div className="inline-error">{firmwareError}</div>}
        {firmware && <div className="firmware-result">
          <div className="firmware-result-header"><span className="eyebrow">USER-SUPPLIED LOG</span><span className="revision-tag">REV {String(firmware.firmware_revision ?? "unknown").slice(0, 12)}</span></div>
          <div className="verification-banner compact-banner"><span className="pending-mark">!</span><div><strong>Physical verification pending</strong><small>These observations describe log text only.</small></div></div>
          <h3>Observed messages</h3>
          {observations.length ? <div className="firmware-observations">{observations.map((item: RecordLike, index: number) => <div className="firmware-observation" key={`${item.kind}-${index}`}><span>{String(item.kind).toUpperCase()}</span><p>{item.summary}</p>{item.line_numbers?.length ? <small>LINES {item.line_numbers.join(", ")}</small> : null}</div>)}</div> : <p className="muted-copy">No recognized observations in the supplied text.</p>}
          <h3>Things to check</h3>
          {hypotheses.length ? <div className="firmware-hypotheses">{hypotheses.map((item: RecordLike, index: number) => <article key={`${item.title}-${index}`}><strong>{item.title}</strong><p>{item.reason}</p>{item.checks?.length > 0 && <ul>{item.checks.map((check: string, checkIndex: number) => <li key={checkIndex}>{check}</li>)}</ul>}</article>)}</div> : <p className="muted-copy">No review suggestions returned.</p>}
          <div className="firmware-provenance">SOURCE · {firmware.source ?? "user_supplied_log"} · no board access or flashing</div>
        </div>}
      </section>

      <section className="panel troubleshooting-panel investigator-panel">
        <div className="troubleshoot-heading"><div><span className="eyebrow">INVESTIGATOR</span><h2>Ask about the current evidence</h2><p>A local asynchronous investigation checks the current session context.</p></div><span className="reasoning-chip">STATUS REQUIRED</span></div>
        <label className="question-field"><span>YOUR QUESTION · MAX 4,000 CHARACTERS</span><textarea value={question} maxLength={4000} onChange={(event) => setQuestion(event.target.value)} placeholder="What does the measured voltage tell us about this divider?" disabled={investigationBusy} /></label>
        <div className="investigator-actions"><span>Uses accepted evidence. An optional selected image is sent only after your review.</span><div>{investigationBusy && <button className="button secondary small" onClick={cancelInvestigation}>Cancel turn</button>}<button className="button secondary small" onClick={() => void askInvestigator(true)} disabled={!sessionId || !question.trim() || investigationBusy}>Investigate with image</button><button className="button primary" onClick={() => void askInvestigator()} disabled={!sessionId || !question.trim() || investigationBusy}>Start investigation <span>→</span></button></div></div>
        {investigationError && <div className="inline-error">{investigationError}</div>}
        {investigation && <div className={`investigation-state ${investigation.status}`}>
          <div className="investigation-state-head"><span className={`turn-dot ${investigation.status}`} /> <strong>{String(investigation.status ?? "starting").toUpperCase()}</strong>{investigation.turn_id && <code>{investigation.turn_id.slice(0, 12)}</code>}</div>
          {investigation.status === "running" && <p>Waiting for the investigation service. This status will refresh automatically.</p>}
          {investigation.status === "completed" && <div className="investigation-answer"><span className="eyebrow">EVIDENCE-GROUNDED RESPONSE</span>
            {isValidatedAnswer(answer) && answer.circuit_revision === circuitRevision ? <>
              <p>{(answer as RecordLike).explanation}</p>
              <div className="investigation-citations"><span>CIRCUIT REVISION <code>{(answer as RecordLike).circuit_revision || "unknown"}</code></span><span>EVIDENCE <code>{Array.isArray((answer as RecordLike).evidence_ids) && (answer as RecordLike).evidence_ids.length ? (answer as RecordLike).evidence_ids.join(" · ") : "none cited"}</code></span></div>
              <div className="proposed-test-note"><strong>Proposed test · review required</strong><span>{(answer as RecordLike).proposed_test_id || "No test proposed"}. This is not approval to run a test.</span></div>
              {localSpeechAvailable && <button className="button secondary small explanation-read-aloud" onClick={() => onReadAloud?.((answer as RecordLike).explanation)} disabled={(answer as RecordLike).explanation.length > 12000}>{(answer as RecordLike).explanation.length > 12000 ? "Explanation too long to read aloud" : "Read explanation · local voice"}</button>}
              {investigation.actual_model && <small>Reasoning model {investigation.actual_model} · {investigation.effort || "effort not reported"}</small>}
            </> : isValidatedAnswer(answer) ? <p>The circuit changed. Start a new investigation for the current evidence.</p> : <pre>{plainAnswer(answer)}</pre>}
          </div>}
          {(investigation.status === "failed" || investigation.status === "cancelled") && <p>{investigation.message || investigation.error || (investigation.status === "cancelled" ? "This turn was cancelled." : "The investigation did not complete.")}</p>}
          {investigation.status === "completed" && investigation.turn_id && <small>Turn {investigation.turn_id} · review cited evidence before acting.</small>}
        </div>}
      </section>
    </div>
  </div>;
}

function isValidatedAnswer(value: unknown): value is { explanation: string; circuit_revision: string; evidence_ids: string[]; proposed_test_id: string } {
  if (!value || typeof value !== "object") return false;
  const answer = value as RecordLike;
  return typeof answer.explanation === "string" && answer.explanation.trim().length > 0
    && typeof answer.circuit_revision === "string" && answer.circuit_revision.length > 0
    && Array.isArray(answer.evidence_ids) && answer.evidence_ids.every((id: unknown) => typeof id === "string")
    && typeof answer.proposed_test_id === "string";
}
