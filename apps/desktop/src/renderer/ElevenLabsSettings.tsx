import { useEffect, useRef, useState, type FormEvent } from "react";

type Connection = {
  connected: boolean;
  storage_status: string;
  generation_enabled: false;
  generation_tested: false;
  selected_voice_id: string | null;
  subscription: { tier: string; character_count: number | null; character_limit: number | null; overage_status: string } | null;
  voices: { voice_id: string; name: string; category: string }[];
  metadata_checked_at: string | null;
  spending_blocked: boolean;
};

async function connectionAction(action: string, payload: Record<string, unknown> = {}): Promise<Connection> {
  if (!window.ohmpath) throw new Error("Open this page in the Ohm Path desktop application.");
  return await window.ohmpath.request(action, payload) as Connection;
}

function readableError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (/encrypt|storage/i.test(code)) return "Windows could not open the protected credential store. No plaintext key will be saved.";
  if (/unauthorized|forbidden|permission|authentication|401|403/i.test(code)) return "The key was not accepted. Check its User, Voices and Models permissions in ElevenLabs.";
  if (/key|credential/i.test(code)) return "Check the API key and try linking again. No speech was requested.";
  if (/network|timeout|fetch/i.test(code)) return "The account information could not be reached. No speech was requested.";
  return "The connection could not be updated. Check the key and internet connection; no speech was requested.";
}

export default function ElevenLabsSettings() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void connectionAction("elevenLabsStatus").then((value) => { if (mounted.current) setConnection(value); })
      .catch(() => { if (mounted.current) setError("Voice connection settings could not be read. Restart Ohm Path after updating it."); });
    return () => { mounted.current = false; if (keyInput.current) keyInput.current.value = ""; };
  }, []);

  async function update(action: string, payload: Record<string, unknown> = {}, success = "") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await connectionAction(action, payload);
      if (mounted.current) { setConnection(value); setNotice(success); }
    } catch (problem) {
      if (mounted.current) setError(readableError(problem));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function link(event: FormEvent) {
    event.preventDefault();
    const apiKey = keyInput.current?.value.trim() ?? "";
    if (!apiKey || busy) return;
    if (keyInput.current) keyInput.current.value = "";
    void update("elevenLabsConnect", { apiKey }, "Account linked. Speech generation remains off; no voice was tested.");
  }

  const count = connection?.subscription?.character_count;
  const limit = connection?.subscription?.character_limit;
  const remaining = typeof count === "number" && typeof limit === "number" ? Math.max(0, limit - count) : null;

  return <section className="panel settings-panel elevenlabs-panel" aria-label="ElevenLabs connection">
    <div className="panel-header"><div><span className="eyebrow">SPOKEN ANSWERS</span><h2>ElevenLabs</h2></div>
      <span className={`runtime-state ${connection?.connected ? "safe" : "paused"}`}>{connection?.connected ? "LINKED · SPEECH OFF" : "NOT LINKED"}</span></div>
    <p>Link your account now and choose a voice for later. This setup only reads account information; it never generates speech or plays previews.</p>
    {!connection?.connected ? <form onSubmit={link} className="elevenlabs-link-form">
      <label htmlFor="elevenlabs-key">ELEVENLABS API KEY</label>
      <input ref={keyInput} id="elevenlabs-key" type="password" autoComplete="off" spellCheck={false} maxLength={256} placeholder="Paste your restricted API key" disabled={busy} />
      <small>Encrypted for your Windows account, outside this project. The key is cleared from this field when submitted.</small>
      <button className="button primary" type="submit" disabled={busy}>{busy ? "Reading account information…" : "Link account · no speech"}</button>
    </form> : <div className="elevenlabs-linked">
      <div className="runtime-row"><span>Available account credits</span><strong>{remaining === null ? "Not reported" : remaining.toLocaleString()}</strong></div>
      <small>This is the account allowance reported at the last check. Your key can have a smaller separate cap.</small>
      <label htmlFor="elevenlabs-voice">VOICE FOR LATER</label>
      <select id="elevenlabs-voice" value={connection.selected_voice_id ?? ""} disabled={busy} onChange={(event) => void update("elevenLabsSelectVoice", { voiceId: event.target.value }, "Voice choice saved without generating or playing audio.")}>
        <option value="" disabled>Choose a voice · no preview</option>
        {connection.voices.map((voice) => <option key={voice.voice_id} value={voice.voice_id}>{voice.name}</option>)}
      </select>
      <div className="elevenlabs-actions">
        <button className="button secondary small" disabled={busy} onClick={() => void update("elevenLabsRefresh", {}, "Account information refreshed. No speech requested.")}>Refresh account information</button>
        <button className="button secondary small" disabled={busy} onClick={() => void update("elevenLabsDisconnect", {}, "Local key removed. You can revoke the API key separately in ElevenLabs.")}>Unlink locally</button>
      </div>
      {connection.subscription?.overage_status !== "disabled" && <p>Usage-based billing is not verified as disabled. Speech must remain blocked until that is resolved.</p>}
    </div>}
    <p className="elevenlabs-credit-note">Speech generation is disabled in this connection setup. No test or preview is available. Voice playback has not been verified.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
