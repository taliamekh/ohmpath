import { useEffect, useRef, useState } from "react";
import "./phone-live-camera.css";

type LinkStatus = {
  link_available?: boolean; active: boolean; session_id: string; state: string; url?: string;
  qr_data_url?: string; answer?: RTCSessionDescriptionInit | null; error?: string;
};
type Props = {
  paused: boolean;
  stopSignal: number;
  showLauncher: boolean;
  onPreparing: () => void;
  onStream: (stream: MediaStream | null) => void;
};

const RECONNECT_KEY = "ohmpath-phone-camera-reconnect";
function rememberConnection(value: boolean) {
  try { if (value) sessionStorage.setItem(RECONNECT_KEY, "1"); else sessionStorage.removeItem(RECONNECT_KEY); }
  catch { /* A private session can still pair manually. */ }
}
function hadConnection() {
  try { return sessionStorage.getItem(RECONNECT_KEY) === "1"; } catch { return false; }
}

async function request(action: string, payload: Record<string, unknown> = {}): Promise<LinkStatus> {
  if (!window.ohmpath?.request) throw new Error("Open Ohm Path on your computer to pair a phone.");
  const result = await window.ohmpath.request(action, payload) as LinkStatus;
  if (result.error) throw new Error(result.error);
  return result;
}

function gathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); resolve(); };
    const changed = () => { if (peer.iceGatheringState === "complete") done(); };
    const timer = window.setTimeout(done, 5000);
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export default function PhoneLiveCamera({ paused, stopSignal, showLauncher, onPreparing, onStream }: Props) {
  const [state, setState] = useState("off");
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const idRef = useRef("");
  const pendingRef = useRef("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);
  const stopSignalReady = useRef(false);
  const restoreAttempted = useRef(false);
  const reconnectAllowed = useRef(false);
  const pageLeaving = useRef(false);
  const callbacks = useRef({ onPreparing, onStream });
  callbacks.current = { onPreparing, onStream };

  function stop(reason = "", preserveForReload = false, reconnect = false) {
    generation.current += 1;
    if (!preserveForReload && !reconnect) {
      rememberConnection(false);
      reconnectAllowed.current = false;
    }
    if (reconnect) reconnectAllowed.current = false;
    busyRef.current = false;
    window.clearTimeout(timerRef.current);
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.getReceivers().forEach(receiver => receiver.track?.stop());
      peer.close();
    }
    const session_id = idRef.current;
    idRef.current = "";
    if (session_id && !preserveForReload) void request("phoneLiveStop", { session_id }).catch(() => undefined);
    const request_id = pendingRef.current;
    pendingRef.current = "";
    if (request_id) void request("phoneLiveCancelStart", { request_id }).catch(() => undefined);
    callbacks.current.onStream(null);
    if (mounted.current) {
      setStatus(previous => previous?.link_available ? { ...previous, active: false, session_id: "", state: "idle", answer: null } : previous);
      setState(reconnect ? "preparing" : "off"); setError(reconnect ? "" : reason);
      setDialogOpen(reconnect || Boolean(reason));
      if (reconnect && !paused) window.setTimeout(() => {
        if (mounted.current && !paused && !busyRef.current && !peerRef.current) void start(true);
      }, 0);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const leaving = () => { pageLeaving.current = true; stop("", true); };
    window.addEventListener("pagehide", leaving);
    return () => { mounted.current = false; window.removeEventListener("pagehide", leaving); stop("", pageLeaving.current); };
  }, []);
  useEffect(() => { if (paused && (peerRef.current || idRef.current || pendingRef.current)) stop(); }, [paused]);
  useEffect(() => {
    if (!stopSignalReady.current) { stopSignalReady.current = true; return; }
    stop();
  }, [stopSignal]);
  useEffect(() => {
    if (!paused && !restoreAttempted.current && hadConnection()) {
      restoreAttempted.current = true;
      void start();
    }
  }, [paused]);
  useEffect(() => {
    const current = generation.current;
    void request("phoneLiveStatus").then(link => {
      if (mounted.current && current === generation.current && link.link_available) setStatus(link);
    }).catch(() => undefined);
  }, []);

  async function start(alreadyStopped = false) {
    if (paused || busyRef.current || peerRef.current) return;
    if (!alreadyStopped) stop("", true);
    busyRef.current = true;
    const current = generation.current;
    const requestId = crypto.randomUUID();
    pendingRef.current = requestId;
    setError(""); setState("preparing"); setDialogOpen(true);
    callbacks.current.onPreparing();
    let link: LinkStatus | undefined;
    try {
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.ontrack = event => {
        if (current !== generation.current || !mounted.current) { event.track.stop(); return; }
        if (event.track.kind !== "video") { event.track.stop(); return; }
        callbacks.current.onStream(new MediaStream([event.track]));
        event.track.addEventListener("ended", () => {
          if (peerRef.current === peer) {
            stop("The phone camera stopped. Reconnecting with the same code…", false, reconnectAllowed.current);
          }
        }, { once: true });
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === "connected") {
          rememberConnection(true); reconnectAllowed.current = true;
          setState("connected"); setDialogOpen(false);
        }
        if (peer.connectionState === "failed") stop("The direct video connection failed. Use the same Wi-Fi, then connect again with this code.");
      };
      await peer.setLocalDescription(await peer.createOffer());
      await gathered(peer);
      if (current !== generation.current || !mounted.current) return;
      link = await request("phoneLiveStart", { request_id: requestId, offer: peer.localDescription?.toJSON() });
      if (current !== generation.current || !mounted.current) {
        if (link.session_id) await request("phoneLiveStop", { session_id: link.session_id }).catch(() => undefined);
        return;
      }
      if (!link.link_available || !link.active || !link.session_id || !link.qr_data_url) throw new Error("The secure phone link could not open.");
      pendingRef.current = "";
      idRef.current = link.session_id;
      setStatus(link); setState("waiting");
      let answerAt = 0;
      let disconnectedAt = 0;
      let misses = 0;
      const poll = async () => {
        if (current !== generation.current || !mounted.current) return;
        try {
          const next = await request("phoneLiveStatus", { session_id: link!.session_id });
          if (current !== generation.current || !mounted.current) return;
          if (!next.active || next.session_id !== link!.session_id) {
            stop(next.error || "The phone camera stopped. Reconnecting with the same code…", false, reconnectAllowed.current); return;
          }
          if (next.answer && !peer.remoteDescription) {
            await peer.setRemoteDescription(next.answer);
            answerAt = Date.now();
            if (current !== generation.current || !mounted.current) return;
            setState("connecting");
          }
          if (peer.connectionState === "connected") {
            disconnectedAt = 0;
            reconnectAllowed.current = true;
            setState("connected");
          } else if (answerAt && Date.now() - answerAt > 30000 && peer.connectionState !== "disconnected") {
            stop("The phone answered, but video could not connect. Keep both devices on the same Wi-Fi; guest networks may block direct connections."); return;
          }
          if (peer.connectionState === "disconnected") {
            disconnectedAt ||= Date.now();
            if (Date.now() - disconnectedAt > 8000) {
              stop("The phone connection was lost. Reconnecting with the same code…", false, reconnectAllowed.current); return;
            }
          }
          misses = 0;
        } catch (failure) {
          if (current !== generation.current || !mounted.current) return;
          if (++misses >= 3) { stop(failure instanceof Error ? failure.message : "The phone connection stopped responding."); return; }
        }
        if (current === generation.current && mounted.current) timerRef.current = window.setTimeout(() => void poll(), 1000);
      };
      void poll();
    } catch (failure) {
      if (current === generation.current && mounted.current) stop(failure instanceof Error ? failure.message : "The phone link could not start.");
    } finally {
      if (current === generation.current) busyRef.current = false;
    }
  }

  return <>
    {showLauncher && state === "off" && <button type="button" className="phone-live-launcher" disabled={paused} onClick={() => void start()}>Connect phone as camera</button>}
    {dialogOpen && <div className="phone-live-dialog-backdrop">
      <section className="phone-live-dialog" role="dialog" aria-modal="true" aria-labelledby="phone-live-title">
        <button type="button" className="phone-live-dialog-close" aria-label="Close phone camera setup" onClick={() => stop()}>×</button>
        <h3 id="phone-live-title">Connect phone as camera</h3>
        <p role="status">{state === "preparing" ? "Preparing your camera code…" : state === "waiting" ? "Scan this code once, then tap Start rear camera on your phone. The same page reconnects after you stop." : state === "connecting" ? "Phone paired · connecting video…" : error || "Ready to connect."}</p>
        {status?.link_available && status.qr_data_url
          ? <div className="phone-live-pairing"><img src={status.qr_data_url} alt="Scan to connect your phone camera to Ohm Path" /><small>Scan once. This same code works until Ohm Path closes.</small></div>
          : state !== "off" && <div className="phone-live-code-loading" aria-hidden="true" />}
        {error && <p className="camera-workspace-error" role="alert">{error}</p>}
        <div className="phone-live-dialog-actions">
          {state === "off" ? <button type="button" onClick={() => void start()}>Try again</button>
            : <button type="button" onClick={() => stop()}>Cancel</button>}
        </div>
      </section>
    </div>}
  </>;
}
