import { useEffect, useRef, useState } from "react";
import "./photo-help.css";

export type PhotoHelpImage = {
  image_id: string;
  data_url: string;
  name: string;
  width: number;
  height: number;
  original_width?: number;
  original_height?: number;
  resized?: boolean;
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
  initialCapture?: PhotoHelpImage;
  onCaptureConsumed?: () => void;
  prefillQuestion?: string;
  onPrefillConsumed?: () => void;
  onActivity?: (activity: "idle" | "thinking" | "error", caption?: string) => void;
  onReadAloud?: (text: string) => void;
  speechAvailable?: boolean;
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
  return [answer.explanation, ...answer.next_steps.slice(0, 3)].join(" ");
}

export default function PhotoHelpPage({ initialCapture, onCaptureConsumed, prefillQuestion = "", onPrefillConsumed, onActivity, onReadAloud, speechAvailable = false }: PhotoHelpPageProps) {
  const [images, setImages] = useState<PhotoHelpImage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [activeNote, setActiveNote] = useState<number | null>(null);
  const imagesRef = useRef<PhotoHelpImage[]>([]);
  const selectedIdRef = useRef("");
  const jobRef = useRef<ActiveJob | null>(null);
  const timerRef = useRef<number | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const contextIdRef = useRef(crypto.randomUUID());
  const mountedRef = useRef(false);
  const consumedCaptureRef = useRef("");
  const latestActivityRef = useRef(onActivity);
  latestActivityRef.current = onActivity;

  function activity(state: "idle" | "thinking" | "error", caption?: string) {
    latestActivityRef.current?.(state, caption);
  }

  function release(imageId: string) {
    void request("photoReleaseImage", { image_id: imageId }).catch(() => undefined);
  }

  function cancelRemote(contextId: string, turnId?: string) {
    void request("photoCancel", { context_id: contextId, ...(turnId ? { turn_id: turnId } : {}) }).catch(() => undefined);
  }

  function cancelJob() {
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
    setActiveNote(null);
    setTurns([]);
    setError("");
  }

  useEffect(() => {
    mountedRef.current = true;
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    return () => {
      mountedRef.current = false;
      cancelJob();
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
    if (!initialCapture || consumedCaptureRef.current === initialCapture.image_id) return;
    consumedCaptureRef.current = initialCapture.image_id;
    if (!validImage(initialCapture)) {
      setError("That capture could not be opened as a PNG or JPEG image.");
      onCaptureConsumed?.();
      return;
    }
    if (!imagesRef.current.some((image) => image.image_id === initialCapture.image_id)) {
      if (imagesRef.current.length < 3) changeImages([...imagesRef.current, initialCapture]);
      else release(initialCapture.image_id);
    }
    onCaptureConsumed?.();
  }, [initialCapture, onCaptureConsumed]);

  useEffect(() => {
    if (!prefillQuestion) return;
    setQuestion(prefillQuestion.slice(0, 4000));
    onPrefillConsumed?.();
  }, [prefillQuestion, onPrefillConsumed]);

  async function chooseImage() {
    if (choosing || imagesRef.current.length >= 3) return;
    setChoosing(true);
    setError("");
    try {
      const result = await request<{ cancelled?: boolean; image?: PhotoHelpImage }>("photoChooseImage");
      if (result?.cancelled) return;
      if (!validImage(result?.image)) throw new Error("The selected file was not a usable PNG or JPEG image.");
      const image = result.image;
      if (!mountedRef.current || imagesRef.current.length >= 3 || imagesRef.current.some((item) => item.image_id === image.image_id)) {
        if (!imagesRef.current.some((item) => item.image_id === image.image_id)) release(image.image_id);
        return;
      }
      changeImages([...imagesRef.current, image]);
      selectedIdRef.current = image.image_id;
      setSelectedId(image.image_id);
    } catch (problem) {
      if (mountedRef.current) setError(problem instanceof Error ? problem.message : "Could not open that image.");
    } finally {
      if (mountedRef.current) setChoosing(false);
    }
  }

  function removeImage(imageId: string) {
    changeImages(imagesRef.current.filter((image) => image.image_id !== imageId));
    release(imageId);
  }

  function finish(job: ActiveJob, result: PhotoJob, askedQuestion: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current) return;
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
      setActiveNote(null);
      setError("");
      activity("idle", speakText(answer));
    } else if (result.status === "cancelled") {
      activity("idle");
    } else {
      const message = result.message || result.error || "Photo help could not complete this request. Please try again.";
      setError(message);
      activity("error", message);
    }
  }

  function fail(job: ActiveJob, message: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current) return;
    cancelJob();
    setError(message);
    activity("error", message);
  }

  async function poll(job: ActiveJob, askedQuestion: string) {
    if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current) return;
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

  async function ask() {
    const askedQuestion = question.trim();
    if (!askedQuestion || !imagesRef.current.length || jobRef.current) return;
    const job: ActiveJob = { context_id: contextIdRef.current, generation: ++generationRef.current, deadline: Date.now() + 90_000 };
    jobRef.current = job;
    setBusy(true);
    setError("");
    try {
      const result = await request<PhotoJob>("photoAsk", {
        context_id: job.context_id,
        question: askedQuestion,
        image_ids: imagesRef.current.map((image) => image.image_id),
      });
      if (jobRef.current !== job || generationRef.current !== job.generation || !mountedRef.current) {
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
  const notes = latest?.answer.annotations.filter((item) => item.image_id === selected?.image_id) ?? [];

  return <main className="photo-help-page">
    <header className="photo-help-heading">
      <div><span className="eyebrow">YOUR VISUAL WORKSPACE</span><h1>Photo help<span aria-hidden="true"> ✦</span></h1><p>Show me a circuit, diagram, or part. Ask one clear question and we’ll work through what’s visible.</p></div>
      <span className="photo-help-private"><span /> Images stay local until you ask</span>
    </header>

    <div className="photo-help-layout">
      <section className="photo-help-visual panel" aria-label="Selected image">
        <div className="photo-help-visual-head"><span><i /> {selected ? selected.name : "Your image goes here"}</span><div className="photo-help-zoom" aria-label="Image zoom"><button type="button" onClick={() => setZoom((value) => Math.max(1, value - .5))} disabled={!selected || zoom <= 1} aria-label="Zoom out">−</button><small>{Math.round(zoom * 100)}%</small><button type="button" onClick={() => setZoom((value) => Math.min(3, value + .5))} disabled={!selected || zoom >= 3} aria-label="Zoom in">+</button></div></div>
        {selected ? <div className="photo-help-scroll" key={selected.image_id}>
          <div className="photo-help-image-wrap" style={{ width: `${zoom * 100}%`, aspectRatio: `${selected.width} / ${selected.height}` }}>
            <img src={selected.data_url} alt={selected.name || "Selected circuit image"} draggable={false} />
            {notes.map((note, index) => <button type="button" key={`${selected.image_id}-${index}`} className={`photo-help-marker ${activeNote === index ? "active" : ""}`} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }} title={note.label} aria-label={`Annotation ${index + 1}: ${note.label}`} onClick={() => setActiveNote(activeNote === index ? null : index)}><span>{index + 1}</span><b className={note.x > .64 ? "left" : ""}>{note.label}</b></button>)}
          </div>
        </div> : <div className="photo-help-empty"><span className="photo-help-empty-icon" aria-hidden="true">▧</span><strong>Start with an image</strong><p>Add a photo of your circuit or a diagram you want to understand.</p><button type="button" className="button primary" onClick={chooseImage} disabled={choosing}>{choosing ? "Opening…" : "Add a photo or diagram"}<span>＋</span></button><small>PNG or JPEG · up to 3 images</small></div>}
        <div className="photo-help-visual-foot"><span>{selected ? `${selected.width} × ${selected.height}${selected.resized ? " · Resized locally" : ""} · ${notes.length ? `${notes.length} marked ${notes.length === 1 ? "detail" : "details"}` : "No marked details yet"}` : "No camera needed"}</span><span>Visual guidance is not a confirmed measurement.</span></div>
      </section>

      <aside className="photo-help-side">
        <section className="panel photo-help-attachments"><div className="photo-help-section-heading"><div><span className="eyebrow">01 / ADD CONTEXT</span><h2>Your images <small>{images.length}/3</small></h2></div><button type="button" className="photo-help-add" onClick={chooseImage} disabled={choosing || images.length >= 3} aria-label="Add image">＋</button></div>
          {images.length ? <div className="photo-help-thumbs">{images.map((image, index) => <div className={`photo-help-thumb ${selected?.image_id === image.image_id ? "selected" : ""}`} key={image.image_id}><button type="button" className="photo-help-thumb-select" onClick={() => { selectedIdRef.current = image.image_id; setSelectedId(image.image_id); setZoom(1); setActiveNote(null); }} aria-label={`View ${image.name}`} aria-pressed={selected?.image_id === image.image_id}><img src={image.data_url} alt="" /><span>{String(index + 1).padStart(2, "0")}</span></button><button type="button" className="photo-help-remove" onClick={() => removeImage(image.image_id)} aria-label={`Remove ${image.name}`} title="Remove image">×</button><small title={image.name}>{image.name}</small></div>)}</div> : <p className="photo-help-attachments-empty">Your selected images will appear here.</p>}
          {images.length > 0 && images.length < 3 && <button type="button" className="photo-help-add-text" onClick={chooseImage} disabled={choosing}>＋ Add another image</button>}
        </section>
        <section className="panel photo-help-ask"><span className="eyebrow">02 / ASK YOUR QUESTION</span><label htmlFor="photo-help-question">What would you like help with?</label><textarea id="photo-help-question" value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 4000))} placeholder="For example: Where should I start checking this board?" rows={4} maxLength={4000} /><p className="photo-help-voice-hint">Ask a follow-up about the same images, or add a clearer close-up.</p><p className="photo-help-disclosure">When you press Ask, your selected images and question go to your signed-in subscription reasoning service.</p><button type="button" className="button primary photo-help-submit" onClick={() => void ask()} disabled={busy || !images.length || !question.trim()}>{busy ? "Looking at your images…" : "Ask about these images"}<span>→</span></button>{busy && <button type="button" className="photo-help-cancel" onClick={cancelJob}>Stop request</button>}{error && <p className="photo-help-error" role="alert">{error}</p>}</section>
      </aside>
    </div>

    {latest && <section className="panel photo-help-answer" aria-live="polite"><div className="photo-help-answer-head"><span className="eyebrow">03 / WHAT I CAN SEE</span><span>Based on these images</span></div><h2>{latest.question}</h2><p className="photo-help-explanation">{latest.answer.explanation}</p>{latest.answer.next_steps.length > 0 && <div className="photo-help-steps"><strong>Try next</strong><ol>{latest.answer.next_steps.slice(0, 4).map((step, index) => <li key={index}>{step}</li>)}</ol></div>}{speechAvailable && onReadAloud && <button type="button" className="button secondary photo-help-listen" onClick={() => onReadAloud(speakText(latest.answer))}>Listen to answer <span>▶</span></button>}{(latest.answer.observations.length > 0 || latest.answer.questions.length > 0 || latest.answer.limitations.length > 0) && <details className="photo-help-details"><summary>More detail and uncertainty</summary>{latest.answer.observations.length > 0 && <div><strong>Visible details</strong><ul>{latest.answer.observations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{latest.answer.questions.length > 0 && <div><strong>Helpful follow-up questions</strong><ul>{latest.answer.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{latest.answer.limitations.length > 0 && <div><strong>What the image cannot confirm</strong><ul>{latest.answer.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</details>}</section>}
    {turns.length > 1 && <section className="photo-help-recent" aria-label="Recent questions"><span className="eyebrow">RECENT QUESTIONS</span>{turns.slice(0, -1).map((turn) => <details key={turn.id}><summary>{turn.question}</summary><p>{turn.answer.explanation}</p></details>)}</section>}
  </main>;
}
