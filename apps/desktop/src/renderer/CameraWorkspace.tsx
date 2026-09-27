import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./camera-workspace.css";
import PhoneLiveCamera from "./PhoneLiveCamera";
import CameraFraming, { suggestMediaRegion } from "./CameraFraming";
import { suggestCircuitRegion, type FrameRegion } from "./circuit-framing";
import { framedImageBox, pointInFrame } from "./camera-framing-geometry";
import { estimateOverheadTilt } from "./overhead-alignment";

export type CameraCapture = {
  data_url: string;
  source: "overview" | "pi";
  captured_at: number;
  focus_region?: FrameRegion;
};

type Props = {
  paused: boolean;
  reservedForTurret?: boolean;
  onSnapshot: (capture: CameraCapture, question?: string) => Promise<void> | void;
  onActivity?: (caption: string) => void;
  guide?: ReactNode;
  voiceControl?: ReactNode | ((ask: (question: string) => Promise<void>) => ReactNode);
  caption?: string;
  subtitlesEnabled?: boolean;
  onSubtitlesChange?: (enabled: boolean) => void;
  headerActions?: ReactNode;
  onRegisterOverviewCapture?: (capture: (() => Promise<void>) | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onPause?: () => void;
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
  catch { throw new Error("The latest Turret frame could not be decoded."); }
  return image;
}

export default function CameraWorkspace({ paused, reservedForTurret = false, onSnapshot, onActivity, guide, voiceControl, caption, subtitlesEnabled, onSubtitlesChange, headerActions, onRegisterOverviewCapture, onFocusChange, onPause }: Props) {
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
  const [straightenOverhead, setStraightenOverhead] = useState(true);
  const [overheadTilt, setOverheadTilt] = useState(0);
  const [alignmentHint, setAlignmentHint] = useState("");
  const [circuitFocus, setCircuitFocus] = useState<{ source: "overview" | "pi"; region: FrameRegion; width: number; height: number; manual?: boolean } | null>(null);
  const [focusCloseUp, setFocusCloseUp] = useState(true);
  const [pickCloseUp, setPickCloseUp] = useState(false);
  const piImageRef = useRef<HTMLImageElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const focusButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusedRef = useRef(false);
  const fallbackFocusRef = useRef(false);
  const nativeFocusActiveRef = useRef(false);
  const overviewCaptureRef = useRef<() => Promise<void>>(() => Promise.resolve());
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
  const reservedForTurretRef = useRef(reservedForTurret);
  const straightenOverheadRef = useRef(straightenOverhead);
  const overviewGeneration = useRef(0);
  const piGeneration = useRef(0);
  const piActiveRef = useRef(false);
  const piModeRef = useRef<"paired" | "tunnel" | null>(null);
  const piConnectingRef = useRef(false);
  const piPollTimer = useRef<number | null>(null);
  const lastOverviewFrameAt = useRef(0);
  const lastAlignmentAt = useRef(0);
  const alignmentCandidate = useRef<{ angle: number; count: number }>({ angle: 0, count: 0 });
  const videoFrameRequest = useRef<number | null>(null);
  const videoTimeUpdate = useRef<(() => void) | null>(null);
  pausedRef.current = paused;
  reservedForTurretRef.current = reservedForTurret;
  straightenOverheadRef.current = straightenOverhead;

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
    setCircuitFocus(previous => previous?.source === "overview" ? null : previous);
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
    lastAlignmentAt.current = 0;
    alignmentCandidate.current = { angle: 0, count: 0 };
    if (mountedRef.current) { setOverviewEnabled(false); setOverheadTilt(0); setAlignmentHint(""); }
  }, []);

  function stopAllOverview() {
    setCircuitFocus(null);
    setPhoneStopSignal(value => value + 1);
    stopOverview();
    if (piActiveRef.current) {
      setLayout("pi");
      setSnapshotSource("pi");
    } else setLayout("overview");
  }

  function preparePhone() {
    setCircuitFocus(null);
    stopOverview();
    setOverviewError("");
    overviewKindRef.current = "phone";
    setOverviewKind("phone");
    setLayout(piActiveRef.current ? "pi" : "overview");
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
      setLayout(piActiveRef.current ? "both" : "overview");
      setSnapshotSource("overview");
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
    setCircuitFocus(previous => previous?.source === "pi" ? null : previous);
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
      setLayout("overview");
      setSnapshotSource("overview");
    }
    return wasActive;
  }, []);

  const disconnectPi = useCallback(async () => {
    const mode = piModeRef.current;
    const wasActive = clearPi();
    piModeRef.current = null;
    if (wasActive && mode) {
      try { await request(mode === "paired" ? "motionDisconnect" : "piVideoDisconnect"); }
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
    if (reservedForTurret) void disconnectPi();
  }, [reservedForTurret, disconnectPi]);

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
      const update = () => { if (generation === overviewGeneration.current && !pausedRef.current) { lastOverviewFrameAt.current = Date.now(); inspectOverhead(video); } };
      videoTimeUpdate.current = update;
      video.addEventListener("timeupdate", update);
      return;
    }
    const tick = () => {
      if (!mountedRef.current || generation !== overviewGeneration.current || pausedRef.current || !streamRef.current) return;
      lastOverviewFrameAt.current = Date.now();
      inspectOverhead(video);
      videoFrameRequest.current = video.requestVideoFrameCallback(tick);
    };
    videoFrameRequest.current = video.requestVideoFrameCallback(tick);
  }

  function inspectOverhead(video: HTMLVideoElement) {
    const now = Date.now();
    if (!straightenOverheadRef.current || now - lastAlignmentAt.current < 1500 || !video.videoWidth || !video.videoHeight) return;
    lastAlignmentAt.current = now;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const region = suggestCircuitRegion(pixels, canvas.width, canvas.height);
      const angle = estimateOverheadTilt(pixels, canvas.width, canvas.height, region ?? undefined);
      if (angle === null) {
        alignmentCandidate.current = { angle: 0, count: 0 };
        setOverheadTilt(0);
        setAlignmentHint("Board angle unclear. Improve light, move obstructions, or choose a clearer overhead view.");
      } else {
        const previous = alignmentCandidate.current;
        const count = Math.abs(previous.angle - angle) <= 3 ? previous.count + 1 : 1;
        alignmentCandidate.current = { angle, count };
        if (count >= 2) { setOverheadTilt(angle); setAlignmentHint(""); }
      }
    } catch {
      setAlignmentHint("Could not assess the overhead angle. The original view is still available for questions.");
    } finally { canvas.width = canvas.height = 1; }
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
      setLayout(piActiveRef.current ? "both" : "overview");
      setSnapshotSource("overview");
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
      const paired = piModeRef.current === "paired";
      const response = paired
        ? await request<{ frame?: { jpeg_base64?: unknown; sequence?: unknown } | null }>("motionFrame")
        : await request<{ jpeg_base64?: unknown; received_at?: unknown } | null>("piVideoFrame");
      if (!mountedRef.current || pausedRef.current || generation !== piGeneration.current || !piActiveRef.current) return;
      const latest = paired ? (response as { frame?: { jpeg_base64?: unknown } | null })?.frame
        : response as { jpeg_base64?: unknown; received_at?: unknown } | null;
      const receivedAt = paired ? Date.now() : Number((response as { received_at?: unknown } | null)?.received_at);
      if (typeof latest?.jpeg_base64 === "string" && latest.jpeg_base64.length > 0 && latest.jpeg_base64.length <= 7_000_000
        && Number.isFinite(receivedAt) && receivedAt <= Date.now() && Date.now() - receivedAt <= FRAME_MAX_AGE_MS) {
        setPiFrame({ url: `data:image/jpeg;base64,${latest.jpeg_base64}`, receivedAt });
      } else {
        setPiFrame(null);
        const status = await request<{ connected?: boolean; reason?: string; message?: string }>(paired ? "motionStatus" : "piVideoStatus");
        if (!mountedRef.current || pausedRef.current || generation !== piGeneration.current || !piActiveRef.current) return;
        if (status.connected !== true) {
          setPiError(paired ? `${status.message || "The paired Pi camera disconnected."} Reconnect the paired camera.`
            : `${status.reason || "The Pi camera stream disconnected."} Check the local tunnel and reconnect with its current token.`);
          clearPi();
          return;
        }
      }
      piPollTimer.current = window.setTimeout(() => { void pollPi(generation); }, paired ? 67 : 250);
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
      piModeRef.current = "tunnel";
      setPiConnected(true);
      setLayout(streamRef.current ? "both" : "pi");
      if (!streamRef.current) setSnapshotSource("pi");
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

  async function connectPairedPi() {
    if (pausedRef.current || reservedForTurretRef.current || piBusy || piActiveRef.current || piConnectingRef.current) return;
    setPiBusy(true);
    setPiError("");
    setPiFrame(null);
    piConnectingRef.current = true;
    const generation = ++piGeneration.current;
    try {
      const status = await request<{ connected?: boolean; armed?: boolean }>("motionStatus");
      if (status.armed) throw new Error("Release turret movement before opening its camera in Live help.");
      const connected = status.connected ? status : await request<{ connected?: boolean; armed?: boolean }>("motionConnect");
      if (connected.connected !== true || connected.armed) throw new Error("The paired Pi camera did not connect in a released state.");
      if (generation !== piGeneration.current || pausedRef.current || reservedForTurretRef.current || !mountedRef.current) {
        await request("motionDisconnect").catch(() => undefined);
        return;
      }
      piModeRef.current = "paired";
      piConnectingRef.current = false;
      piActiveRef.current = true;
      setPiConnected(true);
      setLayout(streamRef.current ? "both" : "pi");
      if (!streamRef.current) setSnapshotSource("pi");
      void pollPi(generation);
      onActivity?.("Paired Pi camera connected alongside the overview camera.");
    } catch (error) {
      if (generation === piGeneration.current && mountedRef.current && !pausedRef.current) {
        piConnectingRef.current = false;
        setPiError(message(error, "The paired Pi camera could not connect."));
      }
    } finally { if (mountedRef.current) setPiBusy(false); }
  }

  async function captureSelected(question?: string, requestedSource?: "overview" | "pi") {
    if (pausedRef.current || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError("");
    try {
      const source = requestedSource ?? snapshotSource;
      let capture: CameraCapture;
      if (source === "overview") {
        const video = videoRef.current;
        if (!overviewEnabled || !streamRef.current?.getVideoTracks().some((track) => track.readyState === "live") || !video
          || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || Date.now() - lastOverviewFrameAt.current > FRAME_MAX_AGE_MS) {
          throw new Error("Wait for a fresh overview camera frame before taking a photo.");
        }
        const manual = Boolean(circuitFocus?.manual && circuitFocus.source === "overview" && circuitFocus.width === video.videoWidth && circuitFocus.height === video.videoHeight);
        const region = manual && circuitFocus ? circuitFocus.region : suggestMediaRegion(video);
        setCircuitFocus(region ? { source: "overview", region, width: video.videoWidth, height: video.videoHeight, manual } : null);
        capture = { data_url: snapshotDataUrl(video), source: "overview", captured_at: Date.now(), ...(region && focusCloseUp ? { focus_region: region } : {}) };
      } else {
        const frame = piFrame;
        if (!piConnected || !frame || Date.now() - frame.receivedAt > FRAME_MAX_AGE_MS) throw new Error("Wait for a fresh Turret camera frame before capturing it.");
        const image = await decodeJpeg(frame.url);
        if (pausedRef.current || !piActiveRef.current || Date.now() - frame.receivedAt > FRAME_MAX_AGE_MS) throw new Error("That Turret frame is no longer current. Try again.");
        const manual = Boolean(circuitFocus?.manual && circuitFocus.source === "pi" && circuitFocus.width === image.naturalWidth && circuitFocus.height === image.naturalHeight);
        const region = manual && circuitFocus ? circuitFocus.region : suggestMediaRegion(image);
        setCircuitFocus(region ? { source: "pi", region, width: image.naturalWidth, height: image.naturalHeight, manual } : null);
        capture = { data_url: snapshotDataUrl(image), source: "pi", captured_at: frame.receivedAt, ...(region && focusCloseUp ? { focus_region: region } : {}) };
      }
      if (pausedRef.current || !mountedRef.current) return;
      setPickCloseUp(false);
      if (focusedRef.current) {
        await Promise.race([exitFocus(), new Promise<void>(resolve => window.setTimeout(resolve, 800))]);
      }
      await onSnapshot(capture, question);
      if (mountedRef.current) onActivity?.(`${capture.source === "pi" ? "Turret" : "Overview"} photo ready in Photo help.`);
    } catch (error) {
      if (mountedRef.current) setSnapshotError(message(error, "The selected frame could not be sent."));
    } finally {
      if (mountedRef.current) setSnapshotBusy(false);
    }
  }

  overviewCaptureRef.current = () => captureSelected(undefined, "overview");

  useEffect(() => {
    const capture = () => overviewCaptureRef.current();
    onRegisterOverviewCapture?.(capture);
    return () => onRegisterOverviewCapture?.(null);
  }, [onRegisterOverviewCapture]);

  const freshPiFrame = piConnected && piFrame && clock - piFrame.receivedAt <= FRAME_MAX_AGE_MS ? piFrame : null;
  const currentSource = snapshotSource === "overview" ? overviewEnabled : Boolean(freshPiFrame);
  const selectedCameraName = overviewKind === "phone" ? "Phone camera" : devices.find((device) => device.deviceId === selectedDevice)?.label;
  const overviewResolution = overviewEnabled && videoRef.current?.videoWidth ? `${videoRef.current.videoWidth} × ${videoRef.current.videoHeight}` : "";
  const overviewRegion = focusCloseUp && overviewEnabled && circuitFocus?.source === "overview"
    && circuitFocus.width === videoRef.current?.videoWidth && circuitFocus.height === videoRef.current?.videoHeight ? circuitFocus.region : undefined;
  const piRegion = focusCloseUp && freshPiFrame && circuitFocus?.source === "pi"
    && circuitFocus.width === piImageRef.current?.naturalWidth && circuitFocus.height === piImageRef.current?.naturalHeight ? circuitFocus.region : undefined;
  const straightenZoom = straightenOverhead && overheadTilt
    ? 1 + Math.min(.55, Math.abs(Math.sin(overheadTilt * Math.PI / 180)) * .9)
    : 1;

  function toggleOverviewCamera() {
    if (overviewEnabled) {
      stopAllOverview();
      void request("disableCamera").catch(() => undefined);
      return;
    }
    void connectOverview();
  }

  function toggleTurretCamera() {
    if (piConnected) void disconnectPi();
    else void connectPairedPi();
  }

  function chooseCloseUp(source: "overview" | "pi", x: number, y: number, container: HTMLElement) {
    const media = source === "overview" ? videoRef.current : piImageRef.current;
    if (!media) return;
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!width || !height) return;
    const bounds = { width: container.clientWidth, height: container.clientHeight };
    const region = source === "overview" ? overviewRegion : piRegion;
    const point = pointInFrame(x, y, framedImageBox(bounds.width, bounds.height, width, height, region), region);
    if (!point) return;
    const side = Math.min(width, height) * .75;
    const w = side / width, h = side / height;
    setCircuitFocus({ source, width, height, manual: true, region: {
      x: Math.max(0, Math.min(1 - w, point.x - w / 2)), y: Math.max(0, Math.min(1 - h, point.y - h / 2)), width: w, height: h,
    } });
    setFocusCloseUp(true); setPickCloseUp(false);
  }

  function closeUpPicker(source: "overview" | "pi") {
    return pickCloseUp && snapshotSource === source ? <button type="button" className="camera-closeup-picker" aria-label="Choose the center of the circuit close-up"
      onClick={event => {
        chooseCloseUp(source, event.nativeEvent.offsetX, event.nativeEvent.offsetY, event.currentTarget);
      }} onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          chooseCloseUp(source, event.currentTarget.clientWidth / 2, event.currentTarget.clientHeight / 2, event.currentTarget);
        }
      }}><span>Click the circuit to center the close-up</span></button> : null;
  }

  return <section ref={workspaceRef} className={`camera-workspace${focused ? " is-focused" : ""}${fallbackFocusRef.current ? " is-fallback-focus" : ""}`} aria-label="Camera workspace">
    <header className="camera-workspace-head">
      <div className="camera-workspace-title">
        {focused && <button ref={focusButtonRef} type="button" className="camera-workspace-focus-button camera-workspace-exit" onClick={() => void exitFocus()}><span aria-hidden="true">← </span>Exit full screen</button>}
        <div><h1>Live help</h1></div>
      </div>
      <div className="camera-workspace-head-actions">{!focused && <>{headerActions}<button ref={focusButtonRef} type="button" className="camera-workspace-focus-button" onClick={() => void enterFocus()}>Full screen</button></>}</div>
    </header>

    <div className={`camera-workspace-stage camera-workspace-stage-${layout}`}>
      <div className="camera-workspace-feed camera-workspace-overview">
        <div className={`camera-workspace-aligned${straightenOverhead ? " is-straightened" : ""}`} style={straightenOverhead && overheadTilt ? { transform: `rotate(${-overheadTilt}deg) scale(${straightenZoom})` } : undefined}>
          <CameraFraming region={overviewRegion} width={videoRef.current?.videoWidth ?? 0} height={videoRef.current?.videoHeight ?? 0}>
            <video ref={videoRef} autoPlay muted playsInline className={overviewEnabled ? "is-visible" : ""} aria-label="Local overview camera preview" />
          </CameraFraming>
          {overviewEnabled && closeUpPicker("overview")}
        </div>
        {!overviewEnabled && <div className="camera-workspace-empty"><span className="camera-workspace-empty-icon">◉</span><strong>Overview camera is off</strong></div>}
        <PhoneLiveCamera paused={paused} stopSignal={phoneStopSignal} showLauncher={!overviewEnabled}
          onPreparing={preparePhone} onStream={acceptPhoneStream} />
        <div className="camera-workspace-feed-label"><span className={overviewEnabled ? "camera-workspace-dot is-live" : "camera-workspace-dot"} /> {overviewKind === "phone" ? "Phone" : "Overview"} <small>{overviewEnabled ? `Direct preview · ${overviewResolution}` : "Not connected"}</small></div>
      </div>
      <div className="camera-workspace-feed camera-workspace-pi">
        {freshPiFrame ? <CameraFraming region={piRegion} width={piImageRef.current?.naturalWidth ?? 0} height={piImageRef.current?.naturalHeight ?? 0}><img ref={piImageRef} src={freshPiFrame.url} alt="Latest Turret camera frame" /></CameraFraming> : <div className="camera-workspace-empty"><span className="camera-workspace-empty-icon">◎</span><strong>{piConnected ? "Waiting for a current frame" : "Turret camera is off"}</strong><span>{piConnected ? "The preview clears when the frame is stale." : "Turn on the Turret camera from the controls below."}</span></div>}
        {freshPiFrame && closeUpPicker("pi")}
        <div className="camera-workspace-feed-label"><span className={freshPiFrame ? "camera-workspace-dot is-live" : "camera-workspace-dot"} /> Turret <small>{freshPiFrame ? "Current frame" : piConnected ? "No current frame" : "Not connected"}</small></div>
      </div>
      {voiceControl && <div className="camera-workspace-voice-control">{typeof voiceControl === "function" ? voiceControl(captureSelected) : voiceControl}</div>}
      {guide && <div className="camera-workspace-focus-guide" aria-label="Guide companion">{guide}</div>}
      {(subtitlesEnabled ?? localSubtitlesEnabled) && caption?.trim() && <p className="camera-workspace-focus-caption" aria-label="Camera subtitles" aria-live="polite" tabIndex={0}>{caption}</p>}
    </div>

    <nav className="camera-controls-menu" aria-label="Live help camera controls">
      <div className="camera-controls-actions">
        <div className="camera-workspace-power" role="group" aria-label="Camera power">
          <button type="button" className={overviewEnabled ? "is-turn-off" : "is-turn-on"} onClick={toggleOverviewCamera} disabled={paused || overviewBusy || (!overviewEnabled && !selectedDevice)} title={!overviewEnabled && !selectedDevice ? "Choose a Windows camera under Camera setup, or connect a phone from the overview feed." : undefined}>{overviewBusy ? "Start overview camera" : overviewEnabled ? "Turn off overview camera" : "Turn on overview camera"}</button>
          <button type="button" className={piConnected ? "is-turn-off" : "is-turn-on"} onClick={toggleTurretCamera} disabled={paused || piBusy || reservedForTurret}>{piBusy ? "Start Turret camera" : piConnected ? "Turn off Turret camera" : "Turn on Turret camera"}</button>
        </div>
        <div className="camera-view-segmented" role="group" aria-label="Camera framing view">
          <button type="button" className="camera-view-option" aria-pressed={focusCloseUp} disabled={!currentSource || paused} onClick={() => { setFocusCloseUp(true); setPickCloseUp(!circuitFocus); }}>Close-up view</button>
          <button type="button" className="camera-view-option" aria-pressed={!focusCloseUp} disabled={!currentSource || paused} onClick={() => { setFocusCloseUp(false); setPickCloseUp(false); }}>Full camera view</button>
        </div>
        <button type="button" className="camera-workspace-focus-button" aria-pressed={straightenOverhead} onClick={() => { setStraightenOverhead(value => !value); setOverheadTilt(0); setAlignmentHint(""); lastAlignmentAt.current = 0; }}>Auto straighten overhead: {straightenOverhead ? "On" : "Off"}</button>
        <button type="button" className="camera-workspace-subtitles-button" onClick={toggleSubtitles} aria-pressed={subtitlesEnabled ?? localSubtitlesEnabled}>{(subtitlesEnabled ?? localSubtitlesEnabled) ? "Subtitles: On" : "Subtitles: Off"}</button>
        <button type="button" className="camera-workspace-focus-button" onClick={() => { stopAllOverview(); void disconnectPi(); onPause?.(); }} disabled={paused}>Pause camera previews</button>
      </div>
      {Boolean(alignmentHint || straightenOverhead && overheadTilt) && <small className="camera-controls-status">{alignmentHint || `Display rotated ${Math.abs(overheadTilt).toFixed(0)}° and zoomed to fill; snapshots keep original pixels.`}</small>}
    </nav>

    {snapshotError && <p className="camera-workspace-error" role="status">{snapshotError}</p>}

    <details className="camera-workspace-setup">
      <summary>Camera setup <span>{overviewEnabled ? selectedCameraName || "Overview connected" : "Overview off"} · {piConnected ? "Turret connected" : "Turret off"}</span></summary>
      <div className="camera-workspace-setup-grid">
        <div className="camera-workspace-setup-card"><h3>Overview camera</h3><p>Windows camera input, including USB or a Camo virtual camera if one is installed.</p>
          {devices.length > 0 && <label>Camera device<select value={selectedDevice} disabled={overviewEnabled || overviewBusy} onChange={(event) => setSelectedDevice(event.target.value)}><option value="">Choose a camera…</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>}
          {!overviewEnabled && <div className="camera-workspace-setup-actions"><button type="button" onClick={() => void discoverOverview()} disabled={paused || overviewBusy}>{overviewBusy ? "Checking…" : devices.length ? "Refresh cameras" : "Enable & list cameras"}</button></div>}
          {overviewError && <p className="camera-workspace-error" role="status">{overviewError}</p>}
        </div>
        <div className="camera-workspace-setup-card"><h3>Turret</h3><p>Use the Turret camera alongside the overhead preview. Turning it on leaves movement released; it does not enable the laser.</p>
          {!piConnected && <details className="camera-workspace-legacy-pi"><summary>Use an existing video tunnel</summary><div className="camera-workspace-pi-fields"><label>Local port<input type="number" min="1024" max="65535" value={piPort} disabled={piBusy} onChange={(event) => setPiPort(event.target.value)} /></label><label>Video token<input type="password" autoComplete="off" value={piToken} disabled={piBusy} onChange={(event) => setPiToken(event.target.value)} placeholder="Per-launch token" /></label></div><button type="button" onClick={() => void connectPi()} disabled={paused || piBusy || !piToken || !piPort}>Connect video tunnel</button></details>}
          {piError && <p className="camera-workspace-error" role="status">{piError}</p>}
        </div>
      </div>
    </details>
    {paused && <p className="camera-workspace-paused">Session paused · camera previews are stopped.</p>}
  </section>;
}
