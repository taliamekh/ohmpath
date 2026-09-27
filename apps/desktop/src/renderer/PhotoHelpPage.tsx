import { useEffect, useId, useRef, useState } from "react";
import "./photo-help.css";
import PhonePhotoLink from "./PhonePhotoLink";
import SpokenQuestion from "./SpokenQuestion";
import type { FrameRegion } from "./circuit-framing";

export type PhotoHelpImage = {
  image_id: string;
  data_url: string;
  name: string;
  width: number;
  height: number;
  original_width?: number;
  original_height?: number;
  resized?: boolean;
  // Display-only framing. The stored original image is still sent by explicit Ask.
  focus_region?: FrameRegion;
};

type Annotation = { image_id: string; x: number; y: number; label: string };
type PhotoAnswer = {
  explanation: string;
  observations: string[];
  questions: string[];
  next_steps: string[];
  annotations: Annotation[];
  limitations: string[];
};
type PhotoJob = {
  turn_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  context_id: string;
  image_revision: string;
  answer?: PhotoAnswer;
  error?: string;
  message?: string;
};
type Turn = { id: string; question: string; answer: PhotoAnswer };
type ActiveJob = { context_id: string; turn_id?: string; generation: number; deadline: number };

export type PhotoHelpPageProps = {
  active?: boolean;
  initialCapture?: PhotoHelpImage;
  onCaptureConsumed?: () => void;
  prefillQuestion?: string;
  onPrefillConsumed?: () => void;
  onActivity?: (activity: "idle" | "listening" | "thinking" | "error", caption?: string) => void;
  onReadAloud?: (text: string) => void;
  onStopSpeaking?: () => void;
  speechAvailable?: boolean;
  phoneTransfer?: boolean;
  onPointWithTurret?: (question: string) => void;
  spokenSubmission?: { id: string; image_id: string; text: string };
  onSpokenSubmissionConsumed?: () => void;
  onPrepareSpeech?: () => void;
};

async function request<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("Photo help is unavailable. Restart Ohm Path and try again.");
  const raw = await window.ohmpath.request(action, payload);
  if (raw && typeof raw === "object") {
    const result = raw as Record<string, unknown>;
    if (result.error && !result.status) throw new Error(typeof result.message === "string" ? result.message : String(result.error));
    if (Object.prototype.hasOwnProperty.call(result, "data")) return result.data as T;
  }
  return raw as T;
}

function validImage(value: unknown): value is PhotoHelpImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<PhotoHelpImage>;
  return typeof image.image_id === "string" && image.image_id.length > 0
    && typeof image.name === "string"
    && typeof image.data_url === "string" && /^data:image\/(png|jpeg);base64,/i.test(image.data_url)
    && typeof image.width === "number" && Number.isFinite(image.width) && image.width > 0
    && typeof image.height === "number" && Number.isFinite(image.height) && image.height > 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function cleanAnswer(value: unknown, imageIds: Set<string>): PhotoAnswer {
  const source = value && typeof value === "object" ? value as Partial<PhotoAnswer> : {};
  const annotations = Array.isArray(source.annotations) ? source.annotations.filter((item): item is Annotation =>
    Boolean(item) && typeof item.image_id === "string" && imageIds.has(item.image_id)
    && typeof item.x === "number" && Number.isFinite(item.x) && item.x >= 0 && item.x <= 1
    && typeof item.y === "number" && Number.isFinite(item.y) && item.y >= 0 && item.y <= 1
    && typeof item.label === "string" && item.label.trim().length > 0,
  ).slice(0, 12) : [];
  return {
    explanation: typeof source.explanation === "string" && source.explanation.trim() ? source.explanation : "I could not form a clear explanation from these images.",
    observations: strings(source.observations),
    questions: strings(source.questions),
    next_steps: strings(source.next_steps),
    annotations,
    limitations: strings(source.limitations),
  };
}

function speakText(answer: PhotoAnswer): string {
  // Speak the active check only. The ordered plan and alternatives stay on screen.
  const parts = [answer.explanation, ...answer.next_steps.slice(0, 1)];
  let text = "";
  for (const part of parts) {
    if ((text + " " + part).trim().length > 940) break;
    text = (text + " " + part).trim();
  }
  if (!text) {
    for (const sentence of answer.explanation.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? []) {
      if ((text + sentence).length > 880) break;
      text += sentence;
    }
  }
  return text.trim() ? text.trim() + (text.trim() !== parts.join(" ") ? " More details are shown on screen." : "")
    : "The circuit review is ready. Please read the explanation and next checks on screen.";
}

function testParts(step: string) {
  const parts = step.split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2 || !/^Test:/i.test(parts[0])) return { instruction: step, meanings: [] as string[] };
  return { instruction: parts[0].replace(/^Test:\s*/i, ""), meanings: parts.slice(1) };
}

export default function PhotoHelpPage({ active = true, initialCapture, onCaptureConsumed, prefillQuestion = "", onPrefillConsumed, onActivity, onReadAloud, onStopSpeaking, speechAvailable = false, phoneTransfer = false, onPointWithTurret, spokenSubmission, onSpokenSubmissionConsumed, onPrepareSpeech }: PhotoHelpPageProps) {
  const questionId = useId();
  const [images, setImages] = useState<PhotoHelpImage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [question, setQuestion] = useState("");
  const [testResult, setTestResult] = useState("");
  const [recordingResult, setRecordingResult] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [recordingQuestion, setRecordingQuestion] = useState(false);
  const [readReplies, setReadReplies] = useState(true);
  const consumedSpokenRef = useRef("");
  const replySpeechRef = useRef({ speechAvailable, readReplies, onReadAloud });
  replySpeechRef.current = { speechAvailable, readReplies, onReadAloud };
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [activeNote, setActiveNote] = useState<number | null>(null);
  const [wholeImage, setWholeImage] = useState(false);
  const imagesRef = useRef<PhotoHelpImage[]>([]);
  const selectedIdRef = useRef("");
  const jobRef = useRef<ActiveJob | null>(null);
  const timerRef = useRef<number | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const choiceGenerationRef = useRef(0);
  const contextIdRef = useRef(crypto.randomUUID());
  const mountedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const consumedCaptureRef = useRef("");
  const latestActivityRef = useRef(onActivity);
  latestActivityRef.current = onActivity;
  const stopSpeakingRef = useRef(onStopSpeaking);
  stopSpeakingRef.current = onStopSpeaking;

  function activity(state: "idle" | "listening" | "thinking" | "error", caption?: string) {
    if (mountedRef.current && activeRef.current) latestActivityRef.current?.(state, caption);
  }

  function release(imageId: string) {
    void request("photoReleaseImage", { image_id: imageId }).catch(() => undefined);
  }

  function cancelRemote(contextId: string, turnId?: string) {
    void request("photoCancel", { context_id: contextId, ...(turnId ? { turn_id: turnId } : {}) }).catch(() => undefined);
  }

  function cancelJob() {
    stopSpeakingRef.current?.();
    generationRef.current += 1;
    const oldContext = contextIdRef.current;
    contextIdRef.current = crypto.randomUUID();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    jobRef.current = null;
    // Also clear completed answers and history held by the local service.
    cancelRemote(oldContext);
    setBusy(false);
    activity("idle", "");
  }

  function changeImages(next: PhotoHelpImage[]) {
    cancelJob();
    imagesRef.current = next;
    setImages(next);
    const selected = next.some((image) => image.image_id === selectedIdRef.current) ? selectedIdRef.current : next[0]?.image_id ?? "";
    selectedIdRef.current = selected;
    setSelectedId(selected);
    setZoom(1);
    setWholeImage(false);
    setActiveNote(null);
    setTurns([]);
    setTestResult("");
    setError("");
  }

  useEffect(() => {
    mountedRef.current = true;
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    return () => {
      const notifyActiveUnmount = activeRef.current;
      mountedRef.current = false;
      choiceGenerationRef.current += 1;
      cancelJob();
      // The camera drawer unmounts when its workspace closes. This synchronous
      // cleanup clears its parent caption; late requests remain silent.
      if (notifyActiveUnmount) latestActivityRef.current?.("idle", "");
      // Deferred cleanup survives React's development-only effect replay.
      releaseTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) {
          imagesRef.current.forEach((image) => release(image.image_id));
          imagesRef.current = [];
        }
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      choiceGenerationRef.current += 1;
      setChoosing(false);
      if (jobRef.current) cancelJob();
      return;
    }
    const latest = turns[turns.length - 1];
    activity("idle", latest ? speakText(latest.answer) : "");
  }, [active]);

  useEffect(() => {
    if (!active || !initialCapture || consumedCaptureRef.current === initialCapture.image_id) return;
    consumedCaptureRef.current = initialCapture.image_id;
    if (!validImage(initialCapture)) {
      setError("That capture could not be opened as a PNG or JPEG image.");
      onCaptureConsumed?.();
      return;
    }
    if (!imagesRef.current.some((image) => image.image_id === initialCapture.image_id)) {
      if (spokenSubmission?.image_id === initialCapture.image_id) changeImages([initialCapture]);
      else if (imagesRef.current.length < 3) changeImages([...imagesRef.current, initialCapture]);
      else {
        release(initialCapture.image_id);
        setError("Three images are already open. Remove one, then capture the new view again.");
        activity("error", "Remove one of the three open images before adding a new camera view.");
        onCaptureConsumed?.();
        return;
      }
    }
    selectedIdRef.current = initialCapture.image_id;
    setSelectedId(initialCapture.image_id);
    setWholeImage(false);
    setZoom(1);
    setActiveNote(null);
    onCaptureConsumed?.();
  }, [active, initialCapture, onCaptureConsumed]);

  useEffect(() => {
    if (!active || recordingQuestion || jobRef.current || !spokenSubmission || consumedSpokenRef.current === spokenSubmission.id
        || !images.some(image => image.image_id === spokenSubmission.image_id)) return;
    consumedSpokenRef.current = spokenSubmission.id;
    setQuestion(spokenSubmission.text);
    void ask(spokenSubmission.text);
    onSpokenSubmissionConsumed?.();
  }, [active, images, spokenSubmission, recordingQuestion, busy]);

  useEffect(() => {
    if (!active || !prefillQuestion) return;
    setQuestion(prefillQuestion.slice(0, 4000));
    onPrefillConsumed?.();
  }, [active, prefillQuestion, onPrefillConsumed]);

  async function chooseOrPaste(action: "photoChooseImage" | "photoPasteImage") {
    if (!activeRef.current || choosing || imagesRef.current.length >= 3) return;
    const choiceGeneration = ++choiceGenerationRef.current;
    setChoosing(true);
    setError("");
    try {
      const result = await request<{ cancelled?: boolean; image?: unknown }>(action);
      if (result?.cancelled) return;
      if (!validImage(result?.image)) {
        const candidate = result?.image;
        const returnedId = candidate && typeof candidate === "object" && "image_id" in candidate
          && typeof candidate.image_id === "string" ? candidate.image_id : "";
        if (returnedId) release(returnedId);
        throw new Error("That image was not a usable PNG or JPEG image.");
      }
      const image = result.image;
      if (!mountedRef.current || !activeRef.current || choiceGeneration !== choiceGenerationRef.current
          || imagesRef.current.length >= 3 || imagesRef.current.some((item) => item.image_id === image.image_id)) {
        if (!imagesRef.current.some((item) => item.image_id === image.image_id)) release(image.image_id);
        return;
      }
      changeImages([...imagesRef.current, image]);
      selectedIdRef.current = image.image_id;
      setSelectedId(image.image_id);
    } catch (problem) {
      if (mountedRef.current && activeRef.current && choiceGeneration === choiceGenerationRef.current)
        setError(problem instanceof Error ? problem.message : "Could not add that image.");
    } finally {
      if (mountedRef.current && choiceGeneration === choiceGenerationRef.current) setChoosing(false);
    }
  }

  function removeImage(imageId: string) {
    changeImages(imagesRef.current.filter((image) => image.image_id !== imageId));
    release(imageId);
  }

  function clearWorkspace() {
    choiceGenerationRef.current += 1;
    const oldImages = [...imagesRef.current];
    changeImages([]);
    oldImages.forEach((image) => release(image.image_id));
    setQuestion("");
    setChoosing(false);
  }

  function finish(job: ActiveJob, result: PhotoJob, askedQuestion: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current || !activeRef.current) return;
    if (result.context_id !== job.context_id) {
      fail(job, "The photo answer belonged to a different request. Please ask again.");
      return;
    }
    if (Date.now() >= job.deadline && result.status === "running") {
      fail(job, "This is taking too long. The request was stopped; please try again.");
      return;
    }
    if (result.status === "running") {
      if (!result.turn_id) {
        fail(job, "The photo request did not return a turn ID.");
        return;
      }
      job.turn_id = result.turn_id;
      activity("thinking", "Looking at your images…");
      setBusy(true);
      timerRef.current = window.setTimeout(() => { void poll(job, askedQuestion); }, 1250);
      return;
    }
    jobRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setBusy(false);
    if (result.status === "completed" && result.answer) {
      const answer = cleanAnswer(result.answer, new Set(imagesRef.current.map((image) => image.image_id)));
      setTurns((current) => [...current, { id: result.turn_id, question: askedQuestion, answer }].slice(-4));
      setTestResult("");
      setActiveNote(null);
      setError("");
      activity("idle", speakText(answer));
      const speech = replySpeechRef.current;
      if (speech.speechAvailable && speech.readReplies) speech.onReadAloud?.(speakText(answer));
    } else if (result.status === "cancelled") {
      activity("idle");
    } else {
      const message = result.message || result.error || "Photo help could not complete this request. Please try again.";
      setError(message);
      activity("error", message);
    }
  }

  function fail(job: ActiveJob, message: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current || !activeRef.current) return;
    cancelJob();
    setError(message);
    activity("error", message);
  }

  async function poll(job: ActiveJob, askedQuestion: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current || !activeRef.current) return;
    if (Date.now() >= job.deadline) {
      fail(job, "This is taking too long. The request was stopped; please try again.");
      return;
    }
    try {
      const result = await request<PhotoJob>("photoStatus", { turn_id: job.turn_id });
      finish(job, result, askedQuestion);
    } catch (problem) {
      fail(job, problem instanceof Error ? problem.message : "Could not check the photo answer.");
    }
  }

  async function ask(submittedQuestion?: string) {
    const askedQuestion = (submittedQuestion ?? question).trim();
    if (!activeRef.current || !askedQuestion || !imagesRef.current.length || jobRef.current || recordingQuestion) return;
    stopSpeakingRef.current?.();
    const job: ActiveJob = { context_id: contextIdRef.current, generation: ++generationRef.current, deadline: Date.now() + 90_000 };
    if (speechAvailable && readReplies) onPrepareSpeech?.();
    jobRef.current = job;
    setBusy(true);
    setError("");
    try {
      const result = await request<PhotoJob>("photoAsk", {
        context_id: job.context_id,
        question: askedQuestion,
        image_ids: imagesRef.current.map((image) => image.image_id),
      });
      if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current || !activeRef.current) {
        // A cancellation can race the first response, before a turn ID was known.
        cancelRemote(job.context_id, result?.turn_id);
        return;
      }
      finish(job, result, askedQuestion);
    } catch (problem) {
      fail(job, problem instanceof Error ? problem.message : "Could not ask about these images.");
    }
  }

  const selected = images.find((image) => image.image_id === selectedId) ?? images[0];
  const latest = turns[turns.length - 1];
  const activeTest = latest?.answer.next_steps[0];
  const activeTestParts = activeTest ? testParts(activeTest) : null;
  const notes = latest?.answer.annotations.filter((item) => item.image_id === selected?.image_id) ?? [];
  const crop = wholeImage ? undefined : selected?.focus_region;

  return <main className="photo-help-page">
    {phoneTransfer && <PhonePhotoLink active={active} accepting={!busy && !choosing && images.length < 3}
      onPhoto={({ image, question: phoneQuestion }) => {
        if (!activeRef.current || !validImage(image) || imagesRef.current.length >= 3 || jobRef.current) {
          release(image.image_id); return;
        }
        changeImages([...imagesRef.current, image]);
        if (phoneQuestion) setQuestion(phoneQuestion.slice(0, 4000));
      }} />}

    <div className="photo-help-layout">
      <section className="photo-help-visual panel" aria-label="Selected image">
        <div className="photo-help-visual-head"><span><i /> {selected ? selected.name : "Your image goes here"}</span><div className="photo-help-zoom" aria-label="Image zoom"><button type="button" onClick={() => setZoom((value) => Math.max(1, value - .5))} disabled={!selected || zoom <= 1} aria-label="Zoom out">−</button><small>{Math.round(zoom * 100)}%</small><button type="button" onClick={() => setZoom((value) => Math.min(3, value + .5))} disabled={!selected || zoom >= 3} aria-label="Zoom in">+</button></div></div>
        {selected?.focus_region && <div className="photo-help-framing"><button type="button" className="button secondary small" onClick={() => { setWholeImage(value => !value); setZoom(1); }}>{wholeImage ? "Circuit close-up" : "Whole image"}</button><small>{wholeImage ? "Complete snapshot" : "Suggested close-up"} · the complete image is included when you ask.</small></div>}
        {selected ? <div className="photo-help-scroll" key={selected.image_id}>
          <div className="photo-help-image-wrap" data-closeup={Boolean(crop)} style={{ width: `${zoom * 100}%`, aspectRatio: `${selected.width * (crop?.width ?? 1)} / ${selected.height * (crop?.height ?? 1)}` }}>
            <div className="photo-help-image-coordinates" style={crop ? { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%` } : undefined}>
            <img src={selected.data_url} alt={selected.name || "Selected circuit image"} draggable={false} />
            {notes.map((note, index) => <button type="button" key={`${selected.image_id}-${index}`} className={`photo-help-marker ${activeNote === index ? "active" : ""}`} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }} hidden={Boolean(crop && (note.x < crop.x || note.x > crop.x + crop.width || note.y < crop.y || note.y > crop.y + crop.height))} title={note.label} aria-label={`Annotation ${index + 1}: ${note.label}`} onClick={() => setActiveNote(activeNote === index ? null : index)}><span>{index + 1}</span><b className={note.x > .64 ? "left" : ""}>{note.label}</b></button>)}
            </div>
          </div>
        </div> : <div className="photo-help-empty"><span className="photo-help-empty-icon" aria-hidden="true">▧</span><strong>Start with an image</strong><p>Add a photo of your circuit or a diagram you want to understand.</p><div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}><button type="button" className="button primary" onClick={() => void chooseOrPaste("photoChooseImage")} disabled={choosing}>{choosing ? "Adding…" : "Add a photo or diagram"}<span>＋</span></button><button type="button" className="button secondary" onClick={() => void chooseOrPaste("photoPasteImage")} disabled={choosing}>Paste image</button></div><small>PNG or JPEG · up to 3 images</small></div>}
        <div className="photo-help-visual-foot"><span>{selected ? `${selected.width} × ${selected.height}${selected.resized ? " · Resized locally" : ""} · ${notes.length ? `${notes.length} marked ${notes.length === 1 ? "detail" : "details"}` : "No marked details yet"}` : "No camera needed"}</span><span>Visual guidance is not a confirmed measurement.</span></div>
      </section>

      <aside className="photo-help-side">
        <section className="panel photo-help-attachments"><div className="photo-help-section-heading"><div><span className="eyebrow">01 / ADD CONTEXT</span><h2>Your images <small>{images.length}/3</small></h2></div><button type="button" className="photo-help-add" onClick={() => void chooseOrPaste("photoChooseImage")} disabled={choosing || images.length >= 3} aria-label="Add image">＋</button></div>
          {images.length ? <div className="photo-help-thumbs">{images.map((image, index) => <div className={`photo-help-thumb ${selected?.image_id === image.image_id ? "selected" : ""}`} key={image.image_id}><button type="button" className="photo-help-thumb-select" onClick={() => { selectedIdRef.current = image.image_id; setSelectedId(image.image_id); setZoom(1); setActiveNote(null); }} aria-label={`View ${image.name}`} aria-pressed={selected?.image_id === image.image_id}><img src={image.data_url} alt="" /><span>{String(index + 1).padStart(2, "0")}</span></button><button type="button" className="photo-help-remove" onClick={() => removeImage(image.image_id)} aria-label={`Remove ${image.name}`} title="Remove image">×</button><small title={image.name}>{image.name}</small></div>)}</div> : <p className="photo-help-attachments-empty">Your selected images will appear here.</p>}
          {images.length > 0 && images.length < 3 && <button type="button" className="photo-help-add-text" onClick={() => void chooseOrPaste("photoChooseImage")} disabled={choosing}>＋ Add another image</button>}
          {images.length > 0 && <button type="button" className="photo-help-add-text" style={{ marginLeft: images.length < 3 ? 16 : 0 }} onClick={() => void chooseOrPaste("photoPasteImage")} disabled={choosing || images.length >= 3}>Paste image</button>}
          <button type="button" className="button secondary small" style={{ marginTop: 12 }} onClick={clearWorkspace} disabled={!images.length && !turns.length && !question && !error && !busy && !choosing}>Clear workspace</button>
        </section>
        <section className="panel photo-help-ask"><span className="eyebrow">02 / ASK YOUR QUESTION</span><label htmlFor={questionId}>What would you like help with?</label>
          <textarea id={questionId} value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 4000))} placeholder="For example: Where should I start checking this board?" rows={4} maxLength={4000} />
          <SpokenQuestion key={contextIdRef.current} active={active} disabled={busy || choosing} onBeforeCapture={onStopSpeaking}
            onText={text => setQuestion(text.slice(0, 4000))}
            onRecording={recording => { setRecordingQuestion(recording); activity(recording ? "listening" : "idle", recording ? "I’m listening. Finish recording when you’re ready." : ""); }} />
          <p className="photo-help-voice-hint">Review your question, then press Ask. Recording fills this draft only.</p><p className="photo-help-disclosure">When you press Ask, your selected images and question go to your signed-in subscription reasoning service.</p>
          <label><input type="checkbox" checked={readReplies} onChange={event => setReadReplies(event.target.checked)} /> Read replies aloud</label>
          {readReplies && !speechAvailable && <p className="photo-help-voice-hint">Enable spoken answers or a local voice in Settings to hear replies.</p>}
          <button type="button" className="button primary photo-help-submit" onClick={() => void ask()} disabled={busy || recordingQuestion || !images.length || !question.trim()}>{busy ? "Looking at your images…" : "Ask about these images"}<span>→</span></button>{busy && <button type="button" className="photo-help-cancel" onClick={cancelJob}>Stop request</button>}{error && <p className="photo-help-error" role="alert">{error}</p>}</section>
      </aside>
    </div>

    {latest && <section className="panel photo-help-answer" aria-live="polite"><div className="photo-help-answer-head"><span className="eyebrow">03 / WHAT I CAN SEE</span><span>Based on these images</span></div><h2>{latest.question}</h2><p className="photo-help-explanation">{latest.answer.explanation}</p>{latest.answer.limitations.length > 0 && <div className="photo-help-limits"><strong>What this view cannot confirm</strong><ul>{latest.answer.limitations.slice(0, 3).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{activeTestParts && <div className="photo-help-steps" aria-label="Ordered test plan"><strong>Test 1 · do this now</strong><p>{activeTestParts.instruction}</p>{activeTestParts.meanings.length > 0 && <ul>{activeTestParts.meanings.map((meaning,index) => <li key={index}>{meaning}</li>)}</ul>}{latest.answer.next_steps.length > 1 && <details><summary>Later tests, in order</summary><ol start={2}>{latest.answer.next_steps.slice(1,3).map((step,index) => <li key={index}>{testParts(step).instruction}</li>)}</ol><p>Wait for the current result before trying these.</p></details>}{onPointWithTurret && <button type="button" className="button secondary small" disabled={busy} onClick={() => onPointWithTurret(activeTest)}>Show this test location with the pointer</button>}<div className="photo-help-test-result"><label htmlFor="photo-test-result">What happened when you ran this test?</label><textarea id="photo-test-result" rows={2} maxLength={1200} value={testResult} onChange={event => setTestResult(event.target.value)} placeholder="Describe the meter reading, visible result, or why you could not run it." /><SpokenQuestion active={active} disabled={busy} onBeforeCapture={onStopSpeaking} onText={text => setTestResult(text.slice(0,1200))} onRecording={setRecordingResult} /><p>A spoken result fills this draft. Check it before submitting; it is a user report, not a confirmed measurement.</p><button type="button" className="button primary small" disabled={busy || recordingResult || !testResult.trim()} onClick={() => void ask(`For test 1, ${activeTestParts.instruction} The user reports: ${testResult.trim()}. Treat this as an unconfirmed user report. Explain what this result suggests, what it cannot establish, and give the single best next test with meanings for plausible results.`)}>Explain this result and choose next test</button></div></div>}{speechAvailable && onReadAloud && <button type="button" className="button secondary photo-help-listen" onClick={() => onReadAloud(speakText(latest.answer))}>Listen to current guidance <span>▶</span></button>}{(latest.answer.observations.length > 0 || latest.answer.questions.length > 0 || latest.answer.limitations.length > 3) && <details className="photo-help-details"><summary>More detail and uncertainty</summary>{latest.answer.observations.length > 0 && <div><strong>Visible details</strong><ul>{latest.answer.observations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{latest.answer.questions.length > 0 && <div><strong>Helpful follow-up questions</strong><ul>{latest.answer.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{latest.answer.limitations.length > 3 && <div><strong>Other limits</strong><ul>{latest.answer.limitations.slice(3).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</details>}</section>}
    {turns.length > 1 && <section className="photo-help-recent" aria-label="Recent questions"><span className="eyebrow">RECENT QUESTIONS</span>{turns.slice(0, -1).map((turn) => <details key={turn.id}><summary>{turn.question}</summary><p>{turn.answer.explanation}</p></details>)}</section>}
  </main>;
}
