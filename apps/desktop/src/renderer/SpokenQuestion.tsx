import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "requesting" | "recording" | "ready" | "transcribing";
type Capture = {
  generation: number;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  frames: number;
  timer: number;
};
type Recorded = { chunks: Float32Array[]; frames: number; sampleRate: number };

export type SpokenQuestionProps = {
  active: boolean;
  disabled?: boolean;
  onText: (text: string) => void;
  onRecording?: (recording: boolean) => void;
  onBeforeCapture?: () => void;
  askOnFinish?: boolean;
};

const MAX_SECONDS = 20;
const WAV_RATE = 16000;
const MAX_WAV_BYTES = 1_500_000;
const MICROPHONE_KEY = "ohmpath.microphoneDeviceId";

function savedMicrophone() {
  try { return localStorage.getItem(MICROPHONE_KEY) || ""; } catch { return ""; }
}

async function speechStatus() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request<{ status?: string; local_only?: boolean }>("voiceStatus"),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Speech status check timed out. Try again.")), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function request<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("unavailable");
  const raw = await window.ohmpath.request(action, payload);
  if (raw && typeof raw === "object") {
    const result = raw as Record<string, unknown>;
    if (result.error && !result.status) throw new Error("unavailable");
    if (Object.prototype.hasOwnProperty.call(result, "data")) return result.data as T;
  }
  return raw as T;
}

function wavBase64(recorded: Recorded): string {
  const { chunks, frames, sampleRate } = recorded;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || frames <= 0
      || frames > Math.ceil(sampleRate * MAX_SECONDS)) throw new Error("invalid_audio");
  const input = new Float32Array(frames);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  if (offset !== frames) throw new Error("invalid_audio");
  const count = Math.min(WAV_RATE * MAX_SECONDS, Math.floor(frames * WAV_RATE / sampleRate));
  const bytes = 44 + count * 2;
  if (!count || bytes > MAX_WAV_BYTES) throw new Error("invalid_audio");
  const wav = new Uint8Array(bytes);
  const view = new DataView(wav.buffer);
  const write = (at: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
  };
  write(0, "RIFF"); view.setUint32(4, bytes - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, WAV_RATE, true); view.setUint32(28, WAV_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index += 1) {
    const position = index * sampleRate / WAV_RATE;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const value = input[left] + (input[right] - input[left]) * (position - left);
    const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  let binary = "";
  for (let at = 0; at < wav.length; at += 0x8000)
    binary += String.fromCharCode(...wav.subarray(at, Math.min(at + 0x8000, wav.length)));
  return btoa(binary);
}

export default function SpokenQuestion({ active, disabled = false, onText, onRecording, onBeforeCapture, askOnFinish = false }: SpokenQuestionProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [available, setAvailable] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [notice, setNotice] = useState("Checking local speech…");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState(savedMicrophone);
  const [microphoneLabel, setMicrophoneLabel] = useState("");
  const captureRef = useRef<Capture | null>(null);
  const recordedRef = useRef<Recorded | null>(null);
  const generationRef = useRef(0);
  const statusGenerationRef = useRef(0);
  const microphoneOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const currentRef = useRef({ active, disabled, onText, onRecording, onBeforeCapture });
  currentRef.current = { active, disabled, onText, onRecording, onBeforeCapture };

  const checkSpeechStatus = useCallback(async () => {
    const generation = ++statusGenerationRef.current;
    setCheckingStatus(true);
    setNotice("Checking local speech…");
    try {
      const status = await speechStatus();
      if (generation !== statusGenerationRef.current) return;
      const ready = status?.local_only === true && ["installed", "ready"].includes(status.status ?? "");
      setAvailable(ready);
      setNotice(ready ? "Local speech ready. Microphone off."
        : status?.status === "not_installed" ? "Local speech files were not found. Check speech setup in Settings."
          : `Local speech is unavailable (${status?.status || "unknown status"}). Check Settings or retry.`);
    } catch (error) {
      if (generation !== statusGenerationRef.current) return;
      setAvailable(false);
      setNotice(error instanceof Error && error.message.includes("timed out") ? error.message : "Could not check local speech status. Check Settings or retry.");
    } finally {
      if (generation === statusGenerationRef.current) setCheckingStatus(false);
    }
  }, []);

  function releaseCapture(retain: boolean): Recorded | null {
    const capture = captureRef.current;
    if (!capture) return null;
    captureRef.current = null;
    window.clearTimeout(capture.timer);
    capture.processor.onaudioprocess = null;
    capture.processor.disconnect();
    capture.source.disconnect();
    capture.stream.getTracks().forEach(track => track.stop());
    if (capture.context.state !== "closed") void capture.context.close().catch(() => undefined);
    if (microphoneOwnerRef.current === capture.generation) microphoneOwnerRef.current = null;
    void request("disableMicrophone").catch(() => undefined);
    currentRef.current.onRecording?.(false);
    const recorded = retain ? { chunks: capture.chunks, frames: capture.frames, sampleRate: capture.context.sampleRate } : null;
    if (!retain) capture.chunks.length = 0;
    return recorded;
  }

  function cancelCapture() {
    generationRef.current += 1;
    releaseCapture(false);
    recordedRef.current = null;
    if (microphoneOwnerRef.current !== null) {
      microphoneOwnerRef.current = null;
      void request("disableMicrophone").catch(() => undefined);
    }
    if (mountedRef.current) { setPhase("idle"); setNotice("Recording cancelled. Nothing was sent."); }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelCapture();
    };
  }, []);

  useEffect(() => {
    if (!active || disabled) {
      statusGenerationRef.current += 1;
      setCheckingStatus(false);
      cancelCapture();
      return;
    }
    setMicrophoneId(savedMicrophone());
    void checkSpeechStatus();
    return () => { statusGenerationRef.current += 1; };
  }, [active, disabled, checkSpeechStatus]);

  async function start() {
    if (phase !== "idle" || !active || disabled || !available) return;
    const generation = ++generationRef.current;
    microphoneOwnerRef.current = generation;
    setPhase("requesting");
    setNotice("Opening microphone…");
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let keepMicrophone = false;
    try {
      const status = await speechStatus();
      if (status?.local_only !== true || !["ready", "installed"].includes(status.status ?? ""))
        throw new Error("local_speech_unavailable");
      if (generation !== generationRef.current || !currentRef.current.active || currentRef.current.disabled) return;
      currentRef.current.onBeforeCapture?.();
      const permission = await request<{ allowed?: boolean }>("enableMicrophone");
      if (permission?.allowed !== true) throw new Error("microphone_unavailable");
      if (generation !== generationRef.current || !currentRef.current.active || currentRef.current.disabled) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("microphone_unavailable");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}) }, video: false,
      });
      if (generation !== generationRef.current || !currentRef.current.active || currentRef.current.disabled) return;
      setMicrophoneLabel(stream.getAudioTracks()[0]?.label || "System default microphone");
      // Device labels are requested only after explicit capture permission.
      void navigator.mediaDevices.enumerateDevices?.().then(devices => {
        if (generation === generationRef.current && mountedRef.current)
          setMicrophones(devices.filter(device => device.kind === "audioinput" && device.deviceId
            && !["default", "communications"].includes(device.deviceId)));
      }).catch(() => undefined);
      context = new window.AudioContext({ sampleRate: WAV_RATE });
      await context.resume();
      if (generation !== generationRef.current || !currentRef.current.active || currentRef.current.disabled) return;
      if (!Number.isFinite(context.sampleRate) || context.sampleRate < 8000 || context.sampleRate > 192000)
        throw new Error("microphone_unavailable");
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const capture: Capture = { generation, stream, context, source, processor, chunks: [], frames: 0, timer: 0 };
      processor.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0);
        const remaining = Math.max(0, Math.ceil(capture.context.sampleRate * MAX_SECONDS) - capture.frames);
        if (remaining) {
          const chunk = input.subarray(0, Math.min(input.length, remaining)).slice();
          capture.chunks.push(chunk);
          capture.frames += chunk.length;
        }
        event.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(context.destination);
      capture.timer = window.setTimeout(() => {
        if (captureRef.current !== capture) return;
        recordedRef.current = releaseCapture(true);
        if (mountedRef.current) { setPhase("ready"); setNotice("20-second limit reached. Finish to transcribe, or cancel."); }
      }, MAX_SECONDS * 1000);
      captureRef.current = capture;
      stream = null;
      context = null;
      keepMicrophone = true;
      setPhase("recording");
      setNotice("Microphone on. Finish to transcribe; cancel to discard.");
      currentRef.current.onRecording?.(true);
    } catch (error) {
      if (generation === generationRef.current && mountedRef.current) {
        setPhase("idle");
        setNotice(error instanceof Error && ["NotFoundError", "OverconstrainedError"].includes(error.name)
          ? "The selected microphone is unavailable. Reconnect it or select System default microphone."
          : "Microphone or local speech is unavailable. Check setup and permission.");
      }
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
      if (!keepMicrophone && microphoneOwnerRef.current === generation) {
        microphoneOwnerRef.current = null;
        void request("disableMicrophone").catch(() => undefined);
      } else if (!keepMicrophone && microphoneOwnerRef.current === null) {
        void request("disableMicrophone").catch(() => undefined);
      }
    }
  }

  async function finish() {
    if (phase !== "recording" && phase !== "ready") return;
    const generation = generationRef.current;
    const recorded = phase === "recording" ? releaseCapture(true) : recordedRef.current;
    recordedRef.current = null;
    if (!recorded?.frames) { setPhase("idle"); setNotice("No audio was captured. Try again."); return; }
    setPhase("transcribing");
    setNotice("Transcribing locally…");
    try {
      const wav_base64 = wavBase64(recorded);
      recorded.chunks.length = 0;
      const result = await request<{ text?: string; status?: string; local_only?: boolean }>("photoTranscribe", { wav_base64 });
      if (generation !== generationRef.current || !mountedRef.current || !currentRef.current.active || currentRef.current.disabled) return;
      const nonSpeech = typeof result.text === "string" && /^(?:\s*(?:\[blank_audio\]|\[no_speech\]|\[silence\]|\(silence\))\s*[.!]?\s*)+$/i.test(result.text);
      if (result?.local_only !== true || result.status !== "final" || nonSpeech || typeof result.text !== "string"
          || !result.text.trim() || result.text.length > 4000) {
        setNotice(result.status === "silence" || nonSpeech ? "No speech detected. Try again." : "No clear words were heard. Try again or type your question.");
      } else {
        currentRef.current.onText(result.text.trim());
        setNotice(askOnFinish ? "Question captured. Opening Photo help for your review…" : "Added to your draft. Review it before asking.");
      }
    } catch {
      if (generation === generationRef.current && mountedRef.current)
        setNotice("Local transcription was unavailable. Try again or type your question.");
    } finally {
      recorded.chunks.length = 0;
      if (generation === generationRef.current && mountedRef.current) setPhase("idle");
    }
  }

  const compactNotice = notice === "Local speech ready. Microphone off." || notice === "Recording cancelled. Nothing was sent."
    ? "Mic off" : notice.startsWith("Question captured.") ? "Saved to draft" : notice;

  return <div className="spoken-question" aria-label="Spoken question" style={{ marginTop: 10 }}>
    {(microphones.length > 0 || microphoneId || microphoneLabel) && <details style={{ marginBottom: 8 }}>
      <summary>Microphone</summary>
      <label style={{ display: "block", marginBottom: 8 }}>Microphone source
      <select style={{ maxWidth: "100%", width: "100%" }} value={microphoneId} disabled={phase !== "idle"} onChange={event => {
        setMicrophoneId(event.target.value);
        try { localStorage.setItem(MICROPHONE_KEY, event.target.value); } catch { /* Session-only selection. */ }
      }}>
        <option value="">System default microphone</option>
        {microphoneId && !microphones.some(device => device.deviceId === microphoneId) && <option value={microphoneId}>Saved microphone (reconnect if unavailable)</option>}
        {microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
      </select>
    </label>
    {microphoneLabel && <small style={{ display: "block" }}>Last opened input: {microphoneLabel}</small>}
    </details>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {phase === "idle" && <button type="button" className="button secondary" disabled={!active || disabled || !available}
        onClick={() => void start()}>{askOnFinish ? "Push to talk" : "Start recording"}</button>}
      {phase === "idle" && active && !disabled && !available && <button type="button" className="button secondary"
        disabled={checkingStatus} onClick={() => void checkSpeechStatus()}>{checkingStatus ? "Checking speech…" : "Retry speech check"}</button>}
      {phase === "requesting" && <button type="button" className="button secondary" disabled>Opening microphone…</button>}
      {(phase === "recording" || phase === "ready") && <button type="button" className="button primary"
        onClick={() => void finish()}>{askOnFinish ? phase === "recording" ? "Mic on · Finish" : "Finish" : "Finish recording"}</button>}
      {phase === "transcribing" && <button type="button" className="button secondary" disabled>Transcribing…</button>}
      {phase !== "idle" && <button type="button" className="button secondary" onClick={cancelCapture}>Cancel recording</button>}
    </div>
    {(!askOnFinish || phase === "idle" || phase === "ready") && <small role="status" aria-live="polite" style={{ display: "block", marginTop: 6 }}>{askOnFinish ? phase === "ready" ? "Recording stopped" : compactNotice : notice}</small>}
  </div>;
}
