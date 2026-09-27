import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./camera-workspace.css";
import VisionOverlay from "./VisionOverlay";
import PhoneLiveCamera from "./PhoneLiveCamera";

export type CameraCapture = {
  data_url: string;
  source: "overview" | "pi";
  captured_at: number;
};

type Props = {
  paused: boolean;
  onSnapshot: (capture: CameraCapture) => Promise<void> | void;
  onActivity?: (caption: string) => void;
  guide?: ReactNode;
  helpPanel?: ReactNode;
  caption?: string;
  subtitlesEnabled?: boolean;
  onSubtitlesChange?: (enabled: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
  onPause?: () => void;
  speechPending?: boolean;
  onStopSpeaking?: () => void;
};
type CameraDevice = { deviceId: string; label: string };
type PiFrame = { url: string; receivedAt: number };
type BridgeReply = Record<string, unknown>;

const PI_SOURCE = "Raspberry Pi camera via an existing local tunnel";
const FRAME_MAX_AGE_MS = 5_000;
const SNAPSHOT_MAX_BYTES = 2_000_000;

async function request<T = BridgeReply>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("The local bench connection is unavailable.");
  const response = await window.ohmpath.request(action, payload);
  if (response && typeof response === "object" && "error" in response) {
    const failure = response as { error?: unknown; message?: unknown };
    throw new Error(typeof failure.message === "string" ? failure.message : String(failure.error));
  }
  return response as T;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function snapshotDataUrl(source: HTMLVideoElement | HTMLImageElement): string {
  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("The selected camera has no decoded frame yet.");
  let scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This device cannot prepare a camera snapshot.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const estimatedBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
      if (dataUrl.startsWith("data:image/jpeg;base64,") && estimatedBytes <= SNAPSHOT_MAX_BYTES) return dataUrl;
    }
    scale *= 0.7;
  }
  throw new Error("This frame is too large to send as a snapshot. Move closer or lower the camera resolution.");
}

async function decodeJpeg(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  try { await image.decode(); }
  catch { throw new Error("The latest Pi frame could not be decoded."); }
  return image;
}

export default function CameraWorkspace({ paused, onSnapshot, onActivity, guide, helpPanel, caption, subtitlesEnabled, onSubtitlesChange, onFocusChange, onPause, speechPending, onStopSpeaking }: Props) {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [overviewEnabled, setOverviewEnabled] = useState(false);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [phoneStopSignal, setPhoneStopSignal] = useState(0);
  const [overviewKind, setOverviewKind] = useState<"local" | "phone">("local");
  const overviewKindRef = useRef<"local" | "phone">("local");
  const [piPort, setPiPort] = useState("8766");
  const [piToken, setPiToken] = useState("");
  const [piConnected, setPiConnected] = useState(false);
  const [piBusy, setPiBusy] = useState(false);
  const [piError, setPiError] = useState("");
  const [piFrame, setPiFrame] = useState<PiFrame | null>(null);
  const [layout, setLayout] = useState<"overview" | "pi" | "both">("overview");
  const [snapshotSource, setSnapshotSource] = useState<"overview" | "pi">("overview");
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [focused, setFocused] = useState(false);
  const [localSubtitlesEnabled, setLocalSubtitlesEnabled] = useState(true);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const piImageRef = useRef<HTMLImageElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const focusButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusedRef = useRef(false);
  const fallbackFocusRef = useRef(false);
  const nativeFocusActiveRef = useRef(false);
  const focusRequestGeneration = useRef(0);
  const focusPendingRef = useRef(false);
  const inertSiblings = useRef<{ element: HTMLElement; previous: boolean }[]>([]);
  const previousBodyOverflow = useRef("");
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const pausedRef = useRef(paused);
  const overviewGeneration = useRef(0);
  const piGeneration = useRef(0);
  const piActiveRef = useRef(false);
  const piConnectingRef = useRef(false);
  const piPollTimer = useRef<number | null>(null);
  const lastOverviewFrameAt = useRef(0);
  const videoFrameRequest = useRef<number | null>(null);
  const videoTimeUpdate = useRef<(() => void) | null>(null);
  pausedRef.current = paused;

  function updateFocus(value: boolean) {
    if (focusedRef.current === value) return;
    focusedRef.current = value;
    setFocused(value);
    onFocusChangeRef.current?.(value);
    if (!value) window.requestAnimationFrame(() => { if (focusButtonRef.current?.isConnected) focusButtonRef.current.focus(); });
  }

  function setOutsideInert(workspace: HTMLElement) {
    let child: HTMLElement | null = workspace;
    while (child && child !== document.body) {
      const parent: HTMLElement | null = child.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== child && sibling instanceof HTMLElement) {
          inertSiblings.current.push({ element: sibling, previous: sibling.inert });
          sibling.inert = true;
        }
      }
      child = parent;
    }
  }

  function restoreOutsideInert() {
    for (const item of inertSiblings.current) item.element.inert = item.previous;
    inertSiblings.current = [];
  }

  function leaveFallbackFocus() {
    if (!fallbackFocusRef.current) return;
    fallbackFocusRef.current = false;
    document.body.style.overflow = previousBodyOverflow.current;
    restoreOutsideInert();
    updateFocus(false);
  }

  async function enterFocus() {
    const workspace = workspaceRef.current;
    if (!workspace || focusedRef.current || focusPendingRef.current) return;
    focusPendingRef.current = true;
    const generation = ++focusRequestGeneration.current;
    let timeout: number | undefined;
    try {
      if (!workspace.requestFullscreen) throw new Error("Fullscreen is unavailable.");
      const nativeRequest = workspace.requestFullscreen();
      void nativeRequest.then(() => {
        if (focusRequestGeneration.current !== generation && document.fullscreenElement === workspace) void document.exitFullscreen().catch(() => undefined);
      }).catch(() => undefined);
      await Promise.race([
        nativeRequest,
        new Promise<void>((_, reject) => { timeout = window.setTimeout(() => reject(new Error("Fullscreen did not start.")), 900); }),
      ]);
      if (focusRequestGeneration.current !== generation) return;
      if (document.fullscreenElement === workspace) {
        updateFocus(true);
        return;
      }
    } catch { /* The same element can still provide an in-app focus view. */ }
    finally { focusPendingRef.current = false; if (timeout !== undefined) window.clearTimeout(timeout); }
    if (focusRequestGeneration.current !== generation) return;
    previousBodyOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    fallbackFocusRef.current = true;
    setOutsideInert(workspace);
    updateFocus(true);
  }

  async function exitFocus() {
    focusRequestGeneration.current += 1;
    if (fallbackFocusRef.current) {
      leaveFallbackFocus();
      if (document.fullscreenElement === workspaceRef.current) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (document.fullscreenElement === workspaceRef.current) {
      try { await document.exitFullscreen(); }
      catch { /* A later fullscreenchange will keep the state in sync. */ }
    } else updateFocus(false);
  }

  useEffect(() => {
    const syncFullscreen = () => {
      if (document.fullscreenElement === workspaceRef.current) {
        nativeFocusActiveRef.current = true;
        updateFocus(true);
      } else {
        const hadNativeFullscreen = nativeFocusActiveRef.current;
        nativeFocusActiveRef.current = false;
        if (fallbackFocusRef.current && hadNativeFullscreen) leaveFallbackFocus();
        else if (!fallbackFocusRef.current) updateFocus(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (fallbackFocusRef.current || focusPendingRef.current)) void exitFocus();
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("keydown", onEscape);
    return () => {
      focusRequestGeneration.current += 1;
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("keydown", onEscape);
      if (document.fullscreenElement === workspaceRef.current) void document.exitFullscreen().catch(() => undefined);
      if (fallbackFocusRef.current) {
        fallbackFocusRef.current = false;
        document.body.style.overflow = previousBodyOverflow.current;
        restoreOutsideInert();
      }
      if (focusedRef.current) { focusedRef.current = false; onFocusChangeRef.current?.(false); }
    };
  }, []);

  function toggleSubtitles() {
    const next = !(subtitlesEnabled ?? localSubtitlesEnabled);
    if (subtitlesEnabled === undefined) setLocalSubtitlesEnabled(next);
    onSubtitlesChange?.(next);
  }

  const stopOverview = useCallback(() => {
    overviewGeneration.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    stopTracks(stream);
    if (videoRef.current) videoRef.current.srcObject = null;
    if (videoRef.current && videoFrameRequest.current !== null && "cancelVideoFrameCallback" in videoRef.current) {
      videoRef.current.cancelVideoFrameCallback(videoFrameRequest.current);
    }
    if (videoRef.current && videoTimeUpdate.current) videoRef.current.removeEventListener("timeupdate", videoTimeUpdate.current);
    videoFrameRequest.current = null;
    videoTimeUpdate.current = null;
    lastOverviewFrameAt.current = 0;
    if (mountedRef.current) { setOverviewEnabled(false); setTrackingEnabled(false); }
  }, []);

  function stopAllOverview() {
    setPhoneStopSignal(value => value + 1);
    stopOverview();
  }

  function preparePhone() {
    stopOverview();
    setOverviewError("");
    overviewKindRef.current = "phone";
    setOverviewKind("phone");
    setLayout("overview");
    setSnapshotSource("overview");
  }

  function acceptPhoneStream(stream: MediaStream | null) {
    if (!stream) {
      if (overviewKindRef.current === "phone") stopOverview();
      return;
    }
    if (pausedRef.current || !mountedRef.current || overviewKindRef.current !== "phone") { stopTracks(stream); return; }
    stopOverview();
    const generation = overviewGeneration.current;
    const video = videoRef.current;
    if (!video) { stopTracks(stream); return; }
    streamRef.current = stream;
    video.srcObject = stream;
    void video.play().then(() => {
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      setOverviewEnabled(true);
      watchOverviewFrames(video, generation);
      onActivity?.("Phone camera connected for a direct preview.");
    }).catch(() => {
      if (generation === overviewGeneration.current && mountedRef.current) {
        stopAllOverview();
        setOverviewError("The phone video could not play. Create a new link and reconnect.");
      }
    });
  }

  const clearPi = useCallback(() => {
    piGeneration.current += 1;
    if (piPollTimer.current !== null) window.clearTimeout(piPollTimer.current);
    piPollTimer.current = null;
    const wasConnecting = piConnectingRef.current;
    const wasActive = piActiveRef.current || wasConnecting;
    piActiveRef.current = false;
    piConnectingRef.current = false;
    if (mountedRef.current) {
      setPiConnected(false);
      setPiFrame(null);
      setPiBusy(wasConnecting);
      setPiToken("");
    }
    return wasActive;
  }, []);

  const disconnectPi = useCallback(async () => {
    const wasActive = clearPi();
    if (wasActive) {
      try { await request("piVideoDisconnect"); }
      catch (error) { if (mountedRef.current) setPiError(message(error, "The Pi camera could not disconnect.")); }
    }
  }, [clearPi]);

  useEffect(() => {
    if (paused) {
      stopOverview();
      void request("disableCamera").catch(() => undefined);
      void disconnectPi();
      setSnapshotError("");
    }
  }, [paused, stopOverview, disconnectPi]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      stopOverview();
      void request("disableCamera").catch(() => undefined);
      void disconnectPi();
    };
  }, [stopOverview, disconnectPi]);

  function watchOverviewFrames(video: HTMLVideoElement, generation: number) {
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
      const update = () => { if (generation === overviewGeneration.current && !pausedRef.current) lastOverviewFrameAt.current = Date.now(); };
      videoTimeUpdate.current = update;
      video.addEventListener("timeupdate", update);
      return;
    }
    const tick = () => {
      if (!mountedRef.current || generation !== overviewGeneration.current || pausedRef.current || !streamRef.current) return;
      lastOverviewFrameAt.current = Date.now();
      videoFrameRequest.current = video.requestVideoFrameCallback(tick);
    };
    videoFrameRequest.current = video.requestVideoFrameCallback(tick);
  }

  async function discoverOverview() {
    if (pausedRef.current || overviewBusy) return;
    setOverviewBusy(true);
    setOverviewError("");
    const generation = ++overviewGeneration.current;
    let temporary: MediaStream | null = null;
    try {
      const result = await request<{ allowed?: boolean }>("enableCamera");
      if (result.allowed !== true) throw new Error("Camera permission was not enabled.");
      if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices.enumerateDevices) throw new Error("Camera capture is unavailable here.");
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      temporary = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stopTracks(temporary);
      temporary = null;
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      const found = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` }));
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      setDevices(found);
      setSelectedDevice(found[0]?.deviceId ?? "");
      if (!found.length) setOverviewError("No camera was listed. Check the USB connection and Windows camera permissions.");
    } catch (error) {
      if (generation === overviewGeneration.current && mountedRef.current && !pausedRef.current) setOverviewError(message(error, "Cameras could not be listed."));
    } finally {
      stopTracks(temporary);
      await request("disableCamera").catch(() => undefined);
      if (mountedRef.current) setOverviewBusy(false);
    }
  }

  async function connectOverview() {
    if (pausedRef.current || overviewBusy || !selectedDevice) return;
    setOverviewBusy(true);
    setOverviewError("");
    stopAllOverview();
    overviewKindRef.current = "local";
    setOverviewKind("local");
    const generation = overviewGeneration.current;
    let opened: MediaStream | null = null;
    try {
      const result = await request<{ allowed?: boolean }>("enableCamera");
      if (result.allowed !== true) throw new Error("Camera permission was not enabled.");
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      opened = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedDevice }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      const video = videoRef.current;
      if (!video) throw new Error("The camera preview is unavailable. Reopen the bench and try again.");
      streamRef.current = opened;
      video.srcObject = opened;
      await video.play();
      if (generation !== overviewGeneration.current || pausedRef.current || !mountedRef.current) return;
      opened.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current === opened) {
          stopOverview();
          setOverviewError("The camera disconnected. Choose it again to reconnect.");
        }
      }, { once: true });
      setOverviewEnabled(true);
      watchOverviewFrames(video, generation);
      onActivity?.("Overview camera connected for local preview.");
    } catch (error) {
      if (generation === overviewGeneration.current && mountedRef.current && !pausedRef.current) {
        stopOverview();
        setOverviewError(message(error, "The selected camera could not connect."));
      }
    } finally {
      if (streamRef.current !== opened) stopTracks(opened);
      await request("disableCamera").catch(() => undefined);
      if (mountedRef.current) setOverviewBusy(false);
    }
  }

  async function pollPi(generation: number) {
    if (!mountedRef.current || pausedRef.current || generation !== piGeneration.current || !piActiveRef.current) return;
    try {
      const latest = await request<{ jpeg_base64?: unknown; received_at?: unknown } | null>("piVideoFrame");
      if (!mountedRef.current || pausedRef.current || generation !== piGeneration.current || !piActiveRef.current) return;
      const receivedAt = Number(latest?.received_at);
      if (typeof latest?.jpeg_base64 === "string" && latest.jpeg_base64.length > 0 && latest.jpeg_base64.length <= 7_000_000
        && Number.isFinite(receivedAt) && receivedAt <= Date.now() && Date.now() - receivedAt <= FRAME_MAX_AGE_MS) {
        setPiFrame({ url: `data:image/jpeg;base64,${latest.jpeg_base64}`, receivedAt });
      } else {
        setPiFrame(null);
        const status = await request<{ connected?: boolean; reason?: string }>("piVideoStatus");
        if (!mountedRef.current || pausedRef.current || generation !== piGeneration.current || !piActiveRef.current) return;
        if (status.connected !== true) {
          setPiError(`${status.reason || "The Pi camera stream disconnected."} Check the local tunnel and reconnect with its current token.`);
          clearPi();
          return;
        }
      }
      piPollTimer.current = window.setTimeout(() => { void pollPi(generation); }, 250);
    } catch (error) {
      if (generation !== piGeneration.current || !mountedRef.current) return;
      setPiError(message(error, "The Pi video tunnel stopped responding."));
      void disconnectPi();
    }
  }

  async function connectPi() {
    const port = Number(piPort);
    if (pausedRef.current || piBusy || !Number.isInteger(port) || port < 1024 || port > 65535 || !piToken) return;
    setPiBusy(true);
    setPiError("");
    setPiFrame(null);
    piConnectingRef.current = true;
    const generation = ++piGeneration.current;
    const token = piToken;
    setPiToken("");
    try {
      const result = await request<{ connected?: boolean; source?: string }>("piVideoConnect", { port, token });
      if (result.connected !== true || result.source !== PI_SOURCE) throw new Error("The local bridge did not confirm a Pi camera source.");
      if (generation !== piGeneration.current || pausedRef.current || !mountedRef.current) {
        void request("piVideoDisconnect").catch(() => undefined);
        return;
      }
      piConnectingRef.current = false;
      piActiveRef.current = true;
      setPiConnected(true);
      setPiBusy(false);
      void pollPi(generation);
      onActivity?.("Pi camera connected through the local tunnel.");
    } catch (error) {
      if (generation === piGeneration.current && mountedRef.current && !pausedRef.current) {
        piConnectingRef.current = false;
        setPiError(message(error, "The Pi camera tunnel could not connect."));
      }
    } finally {
      if (mountedRef.current) setPiBusy(false);
    }
  }

  async function captureSelected() {
    if (pausedRef.current || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError("");
    try {
      let capture: CameraCapture;
      if (snapshotSource === "overview") {
        const video = videoRef.current;
        if (!overviewEnabled || !streamRef.current?.getVideoTracks().some((track) => track.readyState === "live") || !video
          || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || Date.now() - lastOverviewFrameAt.current > FRAME_MAX_AGE_MS) {
          throw new Error("Wait for a fresh overview camera frame before asking about it.");
        }
        capture = { data_url: snapshotDataUrl(video), source: "overview", captured_at: Date.now() };
      } else {
        const frame = piFrame;
        if (!piConnected || !frame || Date.now() - frame.receivedAt > FRAME_MAX_AGE_MS) throw new Error("Wait for a fresh Pi camera frame before asking about it.");
        const image = await decodeJpeg(frame.url);
        if (pausedRef.current || !piActiveRef.current || Date.now() - frame.receivedAt > FRAME_MAX_AGE_MS) throw new Error("That Pi frame is no longer current. Try again.");
        capture = { data_url: snapshotDataUrl(image), source: "pi", captured_at: frame.receivedAt };
      }
      if (pausedRef.current || !mountedRef.current) return;
      await onSnapshot(capture);
      if (mountedRef.current) onActivity?.(`Selected ${capture.source === "pi" ? "Pi" : "overview"} snapshot sent for this question.`);
    } catch (error) {
      if (mountedRef.current) setSnapshotError(message(error, "The selected frame could not be sent."));
    } finally {
      if (mountedRef.current) setSnapshotBusy(false);
    }
  }

  const freshPiFrame = piConnected && piFrame && clock - piFrame.receivedAt <= FRAME_MAX_AGE_MS ? piFrame : null;
  const currentSource = snapshotSource === "overview" ? overviewEnabled : Boolean(freshPiFrame);
  const selectedCameraName = overviewKind === "phone" ? "Phone camera" : devices.find((device) => device.deviceId === selectedDevice)?.label;
  const overviewResolution = overviewEnabled && videoRef.current?.videoWidth ? `${videoRef.current.videoWidth} × ${videoRef.current.videoHeight}` : "";

  return <section ref={workspaceRef} className={`camera-workspace${focused ? " is-focused" : ""}${fallbackFocusRef.current ? " is-fallback-focus" : ""}`} aria-label="Camera workspace">
    <header className="camera-workspace-head">
      <div className="camera-workspace-title">
        {focused && <button ref={focusButtonRef} type="button" className="camera-workspace-focus-button camera-workspace-exit" onClick={() => void exitFocus()}><span aria-hidden="true">← </span>Exit full screen</button>}
        <div><h1>Live help</h1><p>Choose a camera to preview. Send one frame only when you ask about this view.</p></div>
      </div>
      <div className="camera-workspace-head-actions"><div className="camera-workspace-layout" role="group" aria-label="Camera layout">
        <button type="button" className={layout === "overview" ? "selected" : ""} onClick={() => { setLayout("overview"); setSnapshotSource("overview"); }} aria-pressed={layout === "overview"}>Overview</button>
        <button type="button" className={layout === "both" ? "selected" : ""} onClick={() => setLayout("both")} aria-pressed={layout === "both"}>Both</button>
        <button type="button" className={layout === "pi" ? "selected" : ""} onClick={() => { setLayout("pi"); setSnapshotSource("pi"); }} aria-pressed={layout === "pi"}>Pi close-up</button>
      </div><button type="button" className="camera-workspace-subtitles-button" onClick={toggleSubtitles} aria-pressed={subtitlesEnabled ?? localSubtitlesEnabled}>{(subtitlesEnabled ?? localSubtitlesEnabled) ? "Subtitles on" : "Subtitles off"}</button>{!focused && <button ref={focusButtonRef} type="button" className="camera-workspace-focus-button" onClick={() => void enterFocus()}>Full screen</button>}</div>
    </header>

    <div className={`camera-workspace-stage camera-workspace-stage-${layout}`}>
      <div className="camera-workspace-feed camera-workspace-overview">
        <video ref={videoRef} autoPlay muted playsInline className={overviewEnabled ? "is-visible" : ""} aria-label="Local overview camera preview" />
        <VisionOverlay source="overview" enabled={trackingEnabled && snapshotSource === "overview" && overviewEnabled && !paused}
          getFrame={() => videoRef.current && videoRef.current.readyState >= 2 && Date.now() - lastOverviewFrameAt.current <= 1000
            ? { media: videoRef.current, stamp: videoRef.current.currentTime } : null} />
        {!overviewEnabled && <div className="camera-workspace-empty"><span className="camera-workspace-empty-icon">◉</span><strong>Overview camera is off</strong><span>Connect your phone below, or choose a Windows camera.</span></div>}
        <div className="camera-workspace-feed-label"><span className={overviewEnabled ? "camera-workspace-dot is-live" : "camera-workspace-dot"} /> {overviewKind === "phone" ? "Phone" : "Overview"} <small>{overviewEnabled ? `Direct preview · ${overviewResolution}` : "Not connected"}</small></div>
      </div>
      <div className="camera-workspace-feed camera-workspace-pi">
        {freshPiFrame ? <img ref={piImageRef} src={freshPiFrame.url} alt="Latest Raspberry Pi camera frame" /> : <div className="camera-workspace-empty"><span className="camera-workspace-empty-icon">◎</span><strong>{piConnected ? "Waiting for a current frame" : "Pi camera is off"}</strong><span>{piConnected ? "The preview clears when the frame is stale." : "Connect through an existing local tunnel."}</span></div>}
        <VisionOverlay source="pi" enabled={trackingEnabled && snapshotSource === "pi" && Boolean(freshPiFrame) && !paused}
          getFrame={() => freshPiFrame && piImageRef.current?.complete && piImageRef.current.naturalWidth > 0 && Date.now() - freshPiFrame.receivedAt <= 1000
            ? { media: piImageRef.current, stamp: freshPiFrame.receivedAt } : null} />
        <div className="camera-workspace-feed-label"><span className={freshPiFrame ? "camera-workspace-dot is-live" : "camera-workspace-dot"} /> Pi close-up <small>{freshPiFrame ? "Current frame" : piConnected ? "No current frame" : "Not connected"}</small></div>
      </div>
      {focused && guide && <div className="camera-workspace-focus-guide" aria-label="Guide companion">{guide}</div>}
      {(subtitlesEnabled ?? localSubtitlesEnabled) && caption?.trim() && <p className="camera-workspace-focus-caption" aria-label="Camera subtitles" aria-live="polite" tabIndex={0}>{caption}</p>}
    </div>

    {focused && <div className="camera-workspace-focus-bar"><span>{paused ? "Previews stopped" : overviewEnabled || freshPiFrame ? "Camera preview · local" : "No camera connected"}</span><div>{speechPending && onStopSpeaking && <button type="button" onClick={onStopSpeaking}>Stop speaking</button>}<button type="button" onClick={toggleSubtitles} aria-pressed={subtitlesEnabled ?? localSubtitlesEnabled}>{(subtitlesEnabled ?? localSubtitlesEnabled) ? "Subtitles on" : "Subtitles off"}</button><button type="button" onClick={() => { stopAllOverview(); void disconnectPi(); onPause?.(); }} disabled={paused}>Pause previews</button><button type="button" onClick={() => void exitFocus()}>Exit full screen</button></div></div>}

    <div className="camera-workspace-bottom">
      <div className="camera-workspace-capture">
        <label htmlFor="camera-workspace-source">Ask about</label>
        <select id="camera-workspace-source" value={snapshotSource} onChange={(event) => { const source = event.target.value as "overview" | "pi"; setSnapshotSource(source); if (layout !== "both") setLayout(source); }}>
          <option value="overview">Overview camera</option><option value="pi">Pi close-up</option>
        </select>
        <button type="button" className="camera-workspace-ask" onClick={() => void captureSelected()} disabled={paused || snapshotBusy || !currentSource}>{snapshotBusy ? "Preparing frame…" : "Ask about this view"}<span aria-hidden="true">↗</span></button>
      </div>
      <p>Only your selected snapshot is shared for this question. Preview is not continuous analysis.</p>
    </div>
    {snapshotError && <p className="camera-workspace-error" role="status">{snapshotError}</p>}
    <div className="camera-vision-controls">
      <button type="button" className="button secondary small" disabled={paused || !currentSource} aria-pressed={trackingEnabled}
        onClick={() => setTrackingEnabled(value => !value)}>{trackingEnabled ? "Stop visual tracking" : "Track a point locally"}</button>
      <p>Follow a selected feature in the chosen view. Frames stay on this computer; Ask sends a separate snapshot for circuit help.</p>
    </div>

    <PhoneLiveCamera paused={paused} stopSignal={phoneStopSignal} resolution={overviewResolution} onPreparing={preparePhone} onStream={acceptPhoneStream} />
    <details className="camera-workspace-setup">
      <summary>Camera setup <span>{overviewEnabled ? selectedCameraName || "Overview connected" : "Overview off"} · {piConnected ? "Pi connected" : "Pi off"}</span></summary>
      <div className="camera-workspace-setup-grid">
        <div className="camera-workspace-setup-card"><h3>Overview camera</h3><p>Windows camera input, including USB or a Camo virtual camera if one is installed.</p>
          {devices.length > 0 && <label>Camera device<select value={selectedDevice} disabled={overviewEnabled || overviewBusy} onChange={(event) => setSelectedDevice(event.target.value)}><option value="">Choose a camera…</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>}
          <div className="camera-workspace-setup-actions">
            {overviewEnabled ? <button type="button" onClick={() => { stopAllOverview(); void request("disableCamera").catch(() => undefined); }} disabled={paused}>Disconnect overview</button> : <><button type="button" onClick={() => void discoverOverview()} disabled={paused || overviewBusy}>{overviewBusy ? "Checking…" : devices.length ? "Refresh cameras" : "Enable & list cameras"}</button><button type="button" onClick={() => void connectOverview()} disabled={paused || overviewBusy || !selectedDevice}>Connect selected</button></>}
          </div>
          {overviewError && <p className="camera-workspace-error" role="status">{overviewError}</p>}
        </div>
        <div className="camera-workspace-setup-card"><h3>Pi close-up</h3><p>Requires a prepared localhost video tunnel and its per-launch token. No motors or laser are enabled.</p>
          {!piConnected && <div className="camera-workspace-pi-fields"><label>Local port<input type="number" min="1024" max="65535" value={piPort} disabled={piBusy} onChange={(event) => setPiPort(event.target.value)} /></label><label>Video token<input type="password" autoComplete="off" value={piToken} disabled={piBusy} onChange={(event) => setPiToken(event.target.value)} placeholder="Per-launch token" /></label></div>}
          <div className="camera-workspace-setup-actions">{piConnected ? <button type="button" onClick={() => void disconnectPi()}>Disconnect Pi</button> : <button type="button" onClick={() => void connectPi()} disabled={paused || piBusy || !piToken || !piPort}>{piBusy ? "Connecting…" : "Connect Pi camera"}</button>}</div>
          {piError && <p className="camera-workspace-error" role="status">{piError}</p>}
        </div>
      </div>
    </details>
    {helpPanel && <aside className="camera-workspace-help-drawer" aria-label="Photo help review">{helpPanel}</aside>}
    {paused && <p className="camera-workspace-paused">Session paused · camera previews are stopped.</p>}
  </section>;
}
