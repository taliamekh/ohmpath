import { useEffect, useId, useRef, useState } from "react";
import type { PhotoHelpImage } from "./PhotoHelpPage";

type LinkStatus = {
  active: boolean; url?: string; expires_at?: string; qr_data_url?: string;
  received_count?: number; pending?: boolean;
  interfaces: Array<{ address: string; name: string }>;
};
type Received = { image: PhotoHelpImage; question: string };

async function request<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.ohmpath) throw new Error("Open Ohm Path on your computer to link a phone.");
  return await window.ohmpath.request(action, payload) as T;
}

export default function PhonePhotoLink({ active, accepting, onPhoto }: {
  active: boolean; accepting: boolean; onPhoto: (photo: Received) => void;
}) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const latest = useRef({ active, accepting, onPhoto });
  latest.current = { active, accepting, onPhoto };
  const taking = useRef(false);
  const mounted = useRef(false);
  const selectId = useId();

  async function receive() {
    if (taking.current || !latest.current.active || !latest.current.accepting) return;
    taking.current = true;
    try {
      const result = await request<{ photo: Received | null }>("phonePhotoTake");
      if (!result.photo) return;
      if (!mounted.current || !latest.current.active || !latest.current.accepting) {
        await request("photoReleaseImage", { image_id: result.photo.image.image_id });
      } else latest.current.onPhoto(result.photo);
    } catch {
      if (mounted.current) setError("The phone photo could not be received. Try sending it again.");
    } finally { taking.current = false; }
  }

  async function refresh() {
    const value = await request<LinkStatus>("phonePhotoStatus");
    if (!mounted.current) return;
    setStatus(value);
    setAddress(current => value.interfaces.some(item => item.address === current)
      ? current : value.interfaces[0]?.address || "");
    if (value.pending) await receive();
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.ohmpath?.onPhonePhoto?.(() => { void receive(); });
    return () => {
      mounted.current = false;
      unsubscribe?.();
      void request("phonePhotoSetAccepting", { accepting: false }).catch(() => undefined);
      void request("phonePhotoStop").catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let current = true;
    void request("phonePhotoSetAccepting", { accepting: active && accepting })
      .then(() => { if (current && active) return refresh(); })
      .catch(() => { if (current && expanded) setError("Phone pairing is unavailable. Restart Ohm Path after updating it."); });
    return () => { current = false; };
  }, [active, accepting, expanded]);

  useEffect(() => {
    if (!active || !status?.active) return;
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [active, status?.active]);

  async function changeLink(start: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const next = await request<LinkStatus>(start ? "phonePhotoStart" : "phonePhotoStop", start ? { address } : {});
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError(start
        ? "The phone link could not start. Check that your computer is on the same private network as your phone."
        : "The phone link could not close. Close Ohm Path to end sharing.");
    } finally { if (mounted.current) setBusy(false); }
  }

  return <details className="phone-photo-link panel" open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Send a photo from your phone <span>{status?.active ? "Link open" : "Pair with a QR code"}</span></summary>
    {expanded && <div className="phone-photo-link-body">
      <div>
        <p>Connect your phone and computer to the same trusted Wi-Fi. Scan the code, take a photo, then review it here before asking Frieren.</p>
        {!status?.active ? <>
          <label htmlFor={selectId}>Computer connection</label>
          <select id={selectId} value={address} onChange={event => setAddress(event.target.value)} disabled={busy}>
            <option value="" disabled>Choose a private network</option>
            {status?.interfaces.map(item => <option key={item.address} value={item.address}>{item.name} · {item.address}</option>)}
          </select>
          {status && status.interfaces.length === 0 && <p>No private network is available. Connect the laptop to Wi-Fi first.</p>}
          <button className="button secondary" type="button" onClick={() => void changeLink(true)} disabled={busy || !address || !accepting}>Create phone link</button>
        </> : <>
          <p role="status">Ready to receive · {status.received_count || 0} photos sent. This link expires after 15 minutes.</p>
          {!accepting && <p>Finish the current question or remove an image to receive another photo.</p>}
          <button className="button secondary" type="button" onClick={() => void changeLink(false)} disabled={busy}>Close phone link</button>
        </>}
        <small>Local photo transfer uses your network, without encryption. Keep the pairing code private. No photo is sent to the AI until you press Ask.</small>
        {error && <p role="alert" className="inline-error">{error}</p>}
      </div>
      {status?.active && status.qr_data_url && <img className="phone-photo-qr" src={status.qr_data_url} alt="Scan with your phone camera to send photos to this Ohm Path window" />}
    </div>}
  </details>;
}
