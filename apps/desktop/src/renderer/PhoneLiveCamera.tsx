import { useEffect, useRef, useState } from "react";
import "./phone-live-camera.css";

type LinkStatus = {
  link_available?: boolean; active: boolean; session_id: string; state: string; url?: string;
  qr_data_url?: string; answer?: RTCSessionDescriptionInit | null; error?: string;
};
type Props = {
  paused: boolean;
  stopSignal: number;
  resolution: string;
  onPreparing: () => void;
  onStream: (stream: MediaStream | null) => void;
};

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

export default function PhoneLiveCamera({ paused, stopSignal, resolution, onPreparing, onStream }: Props) {
  const [state, setState] = useState("off");
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const idRef = useRef("");
  const pendingRef = useRef("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onPreparing, onStream });
  callbacks.current = { onPreparing, onStream };

  function stop(reason = "") {
    generation.current += 1;
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
    if (session_id) void request("phoneLiveStop", { session_id }).catch(() => undefined);
    const request_id = pendingRef.current;
    pendingRef.current = "";
    if (request_id) void request("phoneLiveCancelStart", { request_id }).catch(() => undefined);
    callbacks.current.onStream(null);
    if (mounted.current) {
      setStatus(previous => previous?.link_available ? { ...previous, active: false, session_id: "", state: "idle", answer: null } : previous);
      setState("off"); setQuality(""); setError(reason);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const leaving = () => stop();
    window.addEventListener("pagehide", leaving);
    return () => { mounted.current = false; window.removeEventListener("pagehide", leaving); stop(); };
  }, []);
  useEffect(() => { if (paused) stop(); }, [paused]);
  useEffect(() => { stop(); }, [stopSignal]);
  useEffect(() => {
    const current = generation.current;
    void request("phoneLiveStatus").then(link => {
      if (mounted.current && current === generation.current && link.link_available) setStatus(link);
    }).catch(() => undefined);
  }, []);

  async function start() {
    if (paused || busyRef.current || peerRef.current) return;
    stop();
    busyRef.current = true;
    const current = generation.current;
    const requestId = crypto.randomUUID();
    pendingRef.current = requestId;
    setError(""); setState("preparing");
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
          if (peerRef.current === peer) stop("The phone camera stopped. Connect again with the same code.");
        }, { once: true });
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === "connected") setState("connected");
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
            stop(next.error || "The phone camera stopped. Connect again with the same code."); return;
          }
          if (next.answer && !peer.remoteDescription) {
            await peer.setRemoteDescription(next.answer);
            answerAt = Date.now();
            if (current !== generation.current || !mounted.current) return;
            setState("connecting");
          }
          if (peer.connectionState === "connected") {
            disconnectedAt = 0;
            setState("connected");
            const stats = await peer.getStats();
            if (current !== generation.current || !mounted.current) return;
            stats.forEach(report => {
              if (report.type === "inbound-rtp" && report.kind === "video" && report.frameWidth) {
                // RTP dimensions can precede the phone's rotation metadata. The
                // parent supplies the decoded video size shown in the preview.
                setQuality(report.framesPerSecond ? `${Math.round(report.framesPerSecond)} fps` : "");
              }
            });
          } else if (answerAt && Date.now() - answerAt > 30000 && peer.connectionState !== "disconnected") {
            stop("The phone answered, but video could not connect. Keep both devices on the same Wi-Fi; guest networks may block direct connections."); return;
          }
          if (peer.connectionState === "disconnected") {
            disconnectedAt ||= Date.now();
            if (Date.now() - disconnectedAt > 8000) { stop("The phone connection was lost. Connect again with this code."); return; }
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

  return <div className="phone-live-camera" aria-label="Direct phone camera">
    <div><h3>Use your phone camera</h3>
      <p>Scan a code in Safari or Chrome. Keep your phone and computer on the same Wi-Fi.</p>
      <div className="camera-workspace-setup-actions">
        {state === "off" ? <button type="button" disabled={paused} onClick={() => void start()}>Connect phone camera</button>
          : <button type="button" onClick={() => stop()}>{state === "connected" ? "Disconnect phone" : "Cancel phone connection"}</button>}
      </div>
      <p role="status">{state === "preparing" ? "Preparing the phone connection…" : state === "waiting" ? "Open this code on your phone, then tap Start rear camera there." : state === "connecting" ? "Phone paired · connecting video…" : state === "connected" ? `Phone connected${resolution ? ` · ${resolution}` : ""}${quality ? ` · ${quality}` : ""}` : "Connect when ready. This code stays the same while Ohm Path is open."}</p>
      {error && <p className="camera-workspace-error" role="alert">{error}</p>}
      <small>Internet is needed for the secure pairing page, provided by Cloudflare. Video travels directly between your devices. Nothing is recorded; Ask sends only your chosen snapshot.</small>
    </div>
    {status?.link_available && status.qr_data_url && <div className="phone-live-pairing"><img src={status.qr_data_url} alt="Scan to connect your phone camera to Ohm Path" /><small>Keep this code private. Same code while Ohm Path stays open.</small></div>}
  </div>;
}
