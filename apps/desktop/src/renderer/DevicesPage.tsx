import { useCallback, useEffect, useRef, useState } from "react";
import CalibrationPanel from "./CalibrationPanel";

type RecordLike = Record<string, any>;
type CameraDevice = { deviceId: string; label: string; groupId: string };
type Point = { x: number; y: number };
type PiVideoStatus = { connected: boolean; state: string; reason?: string; fresh_frame: boolean; source: string };
type AimFrame = {
  target_pixel: Point | number[];
  crosshair_pixel: Point | number[];
  yaw_degrees?: number;
  pitch_degrees?: number;
  phase?: string;
  width?: number;
  height?: number;
};

async function action<T = any>(name: string, payload?: Record<string, unknown>): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("The local bench connection is unavailable.");
  const response = await window.ohmpath.request(name, payload);
  if (response && typeof response === "object" && "error" in response) {
    const result = response as RecordLike;
    throw new Error(result.message || String(result.error));
  }
  return response as T;
}

function point(value: Point | number[] | undefined, fallback: Point): Point {
  if (Array.isArray(value)) return { x: Number(value[0]) || 0, y: Number(value[1]) || 0 };
  if (value && typeof value === "object") return { x: Number(value.x) || 0, y: Number(value.y) || 0 };
  return fallback;
}

function esc(value: number, max: number) { return Math.min(max, Math.max(0, value)); }

export default function DevicesPage({ sid, paused, onStop }: { sid: string; paused: boolean; onStop: () => void }) {
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [piPort, setPiPort] = useState("8766");
  const [piToken, setPiToken] = useState("");
  const [piConnected, setPiConnected] = useState(false);
  const [piSource, setPiSource] = useState("");
  const [piFrame, setPiFrame] = useState("");
  const [piLastFrameAt, setPiLastFrameAt] = useState<number | null>(null);
  const [piBusy, setPiBusy] = useState(false);
  const [piDisconnecting, setPiDisconnecting] = useState(false);
  const [piError, setPiError] = useState("");
  const [aimStatus, setAimStatus] = useState<RecordLike | null>(null);
  const [aimError, setAimError] = useState("");
  const [targetX, setTargetX] = useState(320);
  const [targetY, setTargetY] = useState(210);
  const [demo, setDemo] = useState<RecordLike | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [simBusy, setSimBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const pausedRef = useRef(paused);
  const piConnectedRef = useRef(false);
  const piConnectingRef = useRef(false);
  const piGenerationRef = useRef(0);
  const piPollTimerRef = useRef<number | null>(null);
  const aimGenerationRef = useRef(0);
  pausedRef.current = paused;

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }, []);

  const stopPiPolling = useCallback(() => {
    piGenerationRef.current += 1;
    if (piPollTimerRef.current !== null) window.clearTimeout(piPollTimerRef.current);
    piPollTimerRef.current = null;
    piConnectedRef.current = false;
    piConnectingRef.current = false;
    setPiConnected(false);
    setPiSource("");
    setPiFrame("");
    setPiLastFrameAt(null);
    setPiBusy(false);
    return piGenerationRef.current;
  }, []);

  const disconnectPi = useCallback(async () => {
    const shouldNotify = piConnectedRef.current || piConnectingRef.current;
    stopPiPolling();
    if (shouldNotify) {
      if (mountedRef.current) setPiBusy(true);
      if (mountedRef.current) setPiDisconnecting(true);
      try { await action("piVideoDisconnect", {}); }
      catch (problem) { if (mountedRef.current) setPiError(problem instanceof Error ? problem.message : "The Pi preview disconnect failed."); }
      finally { if (mountedRef.current) { setPiBusy(false); setPiDisconnecting(false); } }
    }
  }, [stopPiPolling]);

  useEffect(() => {
    if (!sid) { setAimStatus(null); return; }
    let active = true;
    action<RecordLike>("aimStatus", { sid }).then((status) => { if (active) setAimStatus(status); })
      .catch((problem) => { if (active) setAimError(problem instanceof Error ? problem.message : "Simulation status is unavailable."); });
    return () => { active = false; };
  }, [sid]);

  useEffect(() => {
    if (paused) {
      aimGenerationRef.current += 1;
      setDemo(null);
      setFrameIndex(0);
      setSimBusy(false);
      setAimError("");
      stopCamera();
      void disconnectPi();
    }
  }, [paused, stopCamera, disconnectPi]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const wasPiActive = piConnectedRef.current || piConnectingRef.current;
      piGenerationRef.current += 1;
      if (piPollTimerRef.current !== null) window.clearTimeout(piPollTimerRef.current);
      piPollTimerRef.current = null;
      piConnectedRef.current = false;
      piConnectingRef.current = false;
      if (wasPiActive) void action("piVideoDisconnect", {}).catch(() => undefined);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  async function pollPiFrame(generation: number) {
    if (!mountedRef.current || pausedRef.current || !piConnectedRef.current || generation !== piGenerationRef.current) return;
    try {
      const latest = await action<RecordLike | null>("piVideoFrame", {});
      if (!mountedRef.current || pausedRef.current || !piConnectedRef.current || generation !== piGenerationRef.current) return;
      if (latest && typeof latest.jpeg_base64 === "string" && latest.jpeg_base64.length > 0 && latest.jpeg_base64.length <= 7_000_000 && Number.isFinite(latest.received_at)) {
        setPiFrame(`data:image/jpeg;base64,${latest.jpeg_base64}`);
        setPiLastFrameAt(Number(latest.received_at));
      } else {
        setPiFrame("");
        setPiLastFrameAt(null);
        const status = await action<PiVideoStatus>("piVideoStatus", {});
        if (!mountedRef.current || pausedRef.current || generation !== piGenerationRef.current) return;
        if (status.connected !== true) {
          stopPiPolling();
          setPiError(status.reason || "The Pi camera connection stopped. Check the local tunnel and enter a fresh video token to reconnect.");
          return;
        }
      }
      piPollTimerRef.current = window.setTimeout(() => { void pollPiFrame(generation); }, 200);
    } catch (problem) {
      if (!mountedRef.current || generation !== piGenerationRef.current) return;
      setPiError(problem instanceof Error ? problem.message : "The Pi video tunnel stopped responding.");
      await disconnectPi();
    }
  }

  async function connectPi() {
    const port = Number(piPort);
    if (pausedRef.current || !Number.isInteger(port) || port < 1 || port > 65535 || !piToken) return;
    setPiError("");
    setPiBusy(true);
    piConnectingRef.current = true;
    const generation = ++piGenerationRef.current;
    try {
      const result = await action<RecordLike>("piVideoConnect", { port, token: piToken });
      setPiToken("");
      if (result?.connected !== true || result?.source !== "Raspberry Pi camera via an existing local tunnel") {
        throw new Error("The local bridge did not confirm a connected Pi camera source.");
      }
      if (!mountedRef.current || pausedRef.current || generation !== piGenerationRef.current) {
        void action("piVideoDisconnect", {}).catch(() => undefined);
        return;
      }
      piConnectingRef.current = false;
      piConnectedRef.current = true;
      setPiConnected(true);
      setPiSource(result.source);
      void pollPiFrame(generation);
    } catch (problem) {
      setPiToken("");
      if (mountedRef.current && generation === piGenerationRef.current) {
        piConnectingRef.current = false;
        setPiError(problem instanceof Error ? problem.message : "The Pi camera tunnel could not connect.");
      }
    } finally {
      if (mountedRef.current && generation === piGenerationRef.current) setPiBusy(false);
    }
  }

  useEffect(() => {
    const frames = demo?.frames as AimFrame[] | undefined;
    if (!frames?.length) return;
    setFrameIndex(0);
    const timer = window.setInterval(() => {
      setFrameIndex((index) => {
        if (index >= frames.length - 1) { window.clearInterval(timer); return index; }
        return index + 1;
      });
    }, 360);
    return () => window.clearInterval(timer);
  }, [demo]);

  async function discoverCameras() {
    if (pausedRef.current) return;
    setCameraError("");
    stopCamera();
    try {
      const permission = await action<RecordLike>("enableCamera");
      if (permission?.allowed !== true) throw new Error("Camera permission was not enabled.");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This environment does not support camera capture.");
      const temporary = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      temporary.getTracks().forEach((track) => track.stop());
      if (!mountedRef.current) return;
      const found = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "videoinput")
        .map((device) => ({ deviceId: device.deviceId, label: device.label || "Camera name unavailable", groupId: device.groupId }));
      setDevices(found);
      setSelectedDevice(found[0]?.deviceId ?? "");
      setPermissionRequested(true);
      if (!found.length) setCameraError("No video input was listed after permission was granted.");
    } catch (problem) {
      setCameraError(problem instanceof Error ? problem.message : "The camera could not be enabled.");
    } finally {
      await action("disableCamera").catch(() => undefined);
    }
  }

  async function connectCamera() {
    if (!selectedDevice || pausedRef.current) return;
    stopCamera();
    setCameraError("");
    try {
      const permission = await action<RecordLike>("enableCamera");
      if (permission?.allowed !== true) throw new Error("Camera permission was not enabled. Press Enable camera & list devices first.");
      if (!mountedRef.current || pausedRef.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedDevice }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      if (!mountedRef.current || pausedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (!videoRef.current) { stream.getTracks().forEach((track) => track.stop()); throw new Error("The preview element is unavailable. Reopen the Devices page and try again."); }
      videoRef.current.srcObject = stream;
      try { await videoRef.current.play(); }
      catch (problem) {
        videoRef.current.srcObject = null;
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(problem instanceof Error ? `Camera opened but preview playback failed: ${problem.message}` : "Camera opened but preview playback failed.");
      }
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack?.addEventListener("ended", () => {
        if (streamRef.current === stream) {
          streamRef.current = null;
          if (videoRef.current) videoRef.current.srcObject = null;
          setStreaming(false);
          setCameraError("Camera disconnected. Re-enable it to select a device again.");
        }
      }, { once: true });
      setStreaming(true);
    } catch (problem) {
      stopCamera();
      setCameraError(problem instanceof Error ? problem.message : "The selected camera could not start.");
    } finally {
      // Revoking future requests does not stop the explicitly opened stream.
      await action("disableCamera").catch(() => undefined);
    }
  }

  async function runSimulation() {
    if (pausedRef.current) return;
    const generation = ++aimGenerationRef.current;
    setAimError("");
    setDemo(null);
    if (!sid) { setAimError("Create a practice session before running the simulator."); return; }
    if (aimStatus?.mode !== "simulation" || aimStatus?.laser_enabled !== false) {
      setAimError("The simulator has not confirmed a simulation-only, laser-disabled state.");
      return;
    }
    setSimBusy(true);
    try {
      const result = await action<RecordLike>("aimDemo", { sid, target_x: targetX, target_y: targetY });
      if (pausedRef.current || generation !== aimGenerationRef.current) return;
      if (result?.mode !== "simulation" || result?.laser_enabled !== false || !Array.isArray(result?.frames)) {
        throw new Error("The response did not confirm a laser-disabled simulation. No result was displayed.");
      }
      setDemo(result);
    } catch (problem) {
      if (!pausedRef.current && generation === aimGenerationRef.current) setAimError(problem instanceof Error ? problem.message : "The aiming simulation failed.");
    } finally {
      if (generation === aimGenerationRef.current) setSimBusy(false);
    }
  }

  const frame = (demo?.frames as AimFrame[] | undefined)?.[frameIndex];
  const target = frame ? point(frame.target_pixel, { x: targetX, y: targetY }) : { x: targetX, y: targetY };
  const crosshair = frame ? point(frame.crosshair_pixel, { x: 320, y: 240 }) : { x: 320, y: 240 };
  const width = Number(frame?.width) || 640;
  const height = Number(frame?.height) || 480;
  const targetPx = { x: esc(target.x, width), y: esc(target.y, height) };
  const crosshairPx = { x: esc(crosshair.x, width), y: esc(crosshair.y, height) };
  const selected = devices.find((device) => device.deviceId === selectedDevice);
  const selectedLabel = selected?.label ?? "No camera selected";
  const canSimulate = Boolean(!paused && sid && aimStatus?.mode === "simulation" && aimStatus?.laser_enabled === false);

  return <div className="devices-page">
    <div className="page-heading"><div><div className="eyebrow">LOCAL CONNECTIONS</div><h1>Devices & guidance</h1><p>Camera access is opt-in. The pointer preview below is simulated and cannot move hardware.</p></div></div>
    <div className="device-grid">
      <section className="panel device-camera-panel">
        <div className="device-section-head"><div><span className="eyebrow">FIXED OVERVIEW</span><h2>Overview camera</h2></div><span className={`device-pill ${streaming ? "live" : "offline"}`}><i />{streaming ? "LOCAL PREVIEW" : "DISCONNECTED"}</span></div>
        <div className="device-preview">
          <video ref={videoRef} className={streaming ? "camera-video-active" : "camera-video-hidden"} autoPlay muted playsInline aria-label="Local camera preview" />
          {!streaming && <div className="device-empty"><span className="camera-glyph"><i /><b /></span><strong>No live preview</strong><small>Camera remains off until you choose and connect it.</small></div>}
          {streaming && <span className="camera-live-label"><i /> LOCAL PREVIEW · NOT RECORDING</span>}
        </div>
        {!permissionRequested ? <button className="button primary" onClick={discoverCameras} disabled={paused}><span>Enable camera & list devices</span><span>→</span></button> : <div className="camera-controls">
          <label className="device-select"><span>CAMERA DEVICE</span><select value={selectedDevice} disabled={streaming || devices.length === 0} onChange={(event) => setSelectedDevice(event.target.value)}><option value="">Choose a camera…</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
          {streaming ? <button className="button secondary" onClick={stopCamera}>Disconnect camera</button> : <button className="button primary" onClick={connectCamera} disabled={!selectedDevice || paused}><span>Connect selected camera</span><span>→</span></button>}
          {selected && <small className="actual-device-name">Selected device name: <strong>{selectedLabel}</strong>{selectedLabel.toLowerCase().includes("camo") ? <em> · Camo identified by device label</em> : null}</small>}
        </div>}
        {cameraError && <div className="inline-error" role="status">{cameraError}</div>}
        <p className="device-privacy">{paused ? "Session paused · camera stream stopped." : "Permission is requested only after you press Enable. Audio is never requested. Disconnect or leave this page to stop the stream."}</p>
      </section>

      <section className="panel device-camera-panel pi-device-panel">
        <div className="device-section-head"><div><span className="eyebrow">MOVING CLOSE-UP</span><h2>Raspberry Pi camera</h2><p>Preview through a local tunnel you prepare separately.</p></div><span className={`device-pill ${piConnected ? "live" : "offline"}`}><i />{piConnected ? "TUNNEL CONNECTED" : "DISCONNECTED"}</span></div>
        <div className="device-preview pi-preview">
          {piFrame ? <img className="pi-live-frame" src={piFrame} alt="Latest raw frame from the Raspberry Pi camera" /> : <div className="device-empty"><span className="pi-camera-glyph">Rπ</span><strong>{piConnected ? "Waiting for the next frame" : "No Pi video frame"}</strong><small>{piConnected ? "The feed stays blank until the tunnel returns a fresh JPEG frame." : "Nothing connects until you enter a token and press Connect."}</small></div>}
          {piConnected && piFrame && <span className="camera-live-label"><i /> LIVE FRAME · NOT RECORDED</span>}
        </div>
        <div className="pi-tunnel-fields">
          <div className="pi-loopback"><span>LOCAL TUNNEL ADDRESS</span><code>127.0.0.1</code><span>Fixed loopback · no remote host field</span></div>
          <label><span>LOCAL PORT</span><input type="number" min={1024} max={65535} step={1} value={piPort} disabled={piConnected || piBusy} onChange={(event) => setPiPort(event.target.value)} /></label>
          <label className="pi-token-field"><span>VIDEO TOKEN · THIS LAUNCH ONLY</span><input type="password" autoComplete="new-password" spellCheck={false} value={piToken} disabled={piConnected || piBusy} onChange={(event) => setPiToken(event.target.value)} placeholder="Paste short-lived tunnel token" /></label>
        </div>
        <div className="pi-tunnel-actions">
          {piConnected ? <button className="button secondary" onClick={() => void disconnectPi()}>Disconnect Pi preview</button> : piBusy ? piDisconnecting ? <button className="button secondary" disabled>Disconnecting…</button> : <button className="button secondary" onClick={() => void disconnectPi()}>Cancel connection</button> : <button className="button primary" onClick={connectPi} disabled={paused || !piToken || !Number.isInteger(Number(piPort)) || Number(piPort) < 1024 || Number(piPort) > 65535}>Connect Pi preview<span>→</span></button>}
          <span>The port and video token are sent only to the local bridge. The token field clears after the attempt and is never saved.</span>
        </div>
        {piError && <div className="inline-error" role="status">{piError}</div>}
        <div className="pi-frame-provenance"><span><b>SOURCE</b>{piSource || "Disconnected · no source"}</span><span><b>LAST FRAME</b>{piLastFrameAt ? new Date(piLastFrameAt).toLocaleTimeString() : "None"}</span><span><b>FRAME RATE</b>Maximum 5 fps</span></div>
        <p className="device-privacy">Before connecting, explicitly opt in on the Pi and establish its separate SSH tunnel to this computer. Ohm Path does not launch SSH or open a remote address. Frames are a raw, temporary preview: no recording, laser-spot detection, or calibration is inferred.</p>
      </section>
    </div>

    <CalibrationPanel sid={sid} />

    <section className="panel aim-simulator-panel">
      <div className="device-section-head aim-header"><div><span className="eyebrow">SPATIAL GUIDANCE</span><h2>Aiming crosshair simulator</h2><p>Shows how a predicted crosshair converges in a synthetic frame. No motor or laser control is available.</p></div><div className="sim-only-stamp"><i />SIMULATION ONLY<br /><small>LASER DISABLED</small></div></div>
      <div className="aim-sim-grid">
        <div className="aim-sim-display">
          <div className="aim-display-tag"><span>SIMULATED BOARD PLANE</span><span>NO CAMERA FRAME</span></div>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Simulated target and predicted crosshair">
            <defs><pattern id="aim-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#24424b" strokeWidth="1" /></pattern></defs>
            <rect x="0" y="0" width={width} height={height} fill="#0a1922" /><rect x="0" y="0" width={width} height={height} fill="url(#aim-grid)" />
            <rect x="18" y="18" width={width - 36} height={height - 36} rx="10" fill="none" stroke="#31515a" strokeDasharray="5 7" />
            <g className="target-marker" transform={`translate(${targetPx.x} ${targetPx.y})`}><circle r="19" /><circle r="6" /><path d="M-25 0H25M0-25V25" /></g>
            <g className="predicted-crosshair" transform={`translate(${crosshairPx.x} ${crosshairPx.y})`}><circle r="15" /><path d="M-25 0H25M0-25V25" /><circle r="2" /></g>
            <text x={Math.min(width - 112, targetPx.x + 23)} y={Math.max(14, targetPx.y - 15)} className="svg-target-label">TARGET · USER-SELECTED</text>
            <text x={Math.min(width - 116, crosshairPx.x + 18)} y={Math.min(height - 12, crosshairPx.y + 27)} className="svg-crosshair-label">PREDICTED CROSSHAIR</text>
          </svg>
          {!demo && <div className="aim-idle-note">Set a target and run the simulator to see predicted motion.</div>}
          {demo && <div className="aim-frame-meta"><span>FRAME {String(frameIndex + 1).padStart(2, "0")} / {String(demo.frames.length).padStart(2, "0")}</span><span>{frame?.phase ? frame.phase.toUpperCase() : "SIMULATION"}</span><span>NO OBSERVED SPOT</span></div>}
        </div>
        <div className="aim-controls">
          <div className="sim-state-card"><span className="eyebrow">CONTROLLER STATE</span><strong>{aimStatus?.mode === "simulation" ? "Simulation" : "Not paired"}</strong><div><span>Mode</span><b>{aimStatus?.mode ?? "—"}</b></div><div><span>Laser emission</span><b className="state-disabled">{aimStatus?.laser_enabled === false ? "Disabled" : "Unavailable"}</b></div><div><span>Camera pose</span><b>{aimStatus?.camera_pose_valid === true ? "Valid" : "No live pose"}</b></div></div>
          <div className="target-inputs"><label><span>TARGET X · PX</span><input type="number" min={0} max={640} value={targetX} onChange={(event) => setTargetX(Number(event.target.value))} /></label><label><span>TARGET Y · PX</span><input type="number" min={0} max={480} value={targetY} onChange={(event) => setTargetY(Number(event.target.value))} /></label></div>
          <button className="button primary run-aim-button" onClick={runSimulation} disabled={!canSimulate || simBusy || !sid}>{simBusy ? "Simulating…" : "Run aiming simulation"}<span>→</span></button>
          <button className="button secondary stop-session-button" onClick={onStop} disabled={!sid || paused}>Stop & pause local session</button>
          {demo && <div className={`aim-result ${demo.converged ? "converged" : "fault"}`}><strong>{demo.converged ? "Converged in simulation" : "Simulation stopped"}</strong><span>{demo.converged ? "The crosshair reached the target coordinates." : demo.fault || "No convergence reported."}</span>{frame && <small>Yaw {Number(frame.yaw_degrees ?? 0).toFixed(1)}° · Pitch {Number(frame.pitch_degrees ?? 0).toFixed(1)}° · {frame.phase ?? "simulation"}</small>}</div>}
          {aimError && <div className="inline-error" role="status">{aimError}</div>}
          {!canSimulate && !aimError && <small className="sim-disabled-note">Waiting for an explicit simulation-only, laser-disabled controller status.</small>}
        </div>
      </div>
      <div className="aim-legend"><span><i className="legend-target" /> User-selected target</span><span><i className="legend-crosshair" /> Predicted crosshair</span><span><i className="legend-disabled" /> No observed laser spot</span></div>
    </section>
  </div>;
}
