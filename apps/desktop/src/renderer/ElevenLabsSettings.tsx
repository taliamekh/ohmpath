import { useEffect, useRef, useState, type FormEvent } from "react";

type Connection = {
  connected: boolean;
  storage_status: string;
  generation_enabled: boolean;
  generation_tested: false;
  selected_voice_id: string | null;
  subscription: { tier: string; character_count: number | null; character_limit: number | null; overage_status: string } | null;
  voices: { voice_id: string; name: string; category: string }[];
  metadata_checked_at: string | null;
  spending_blocked: boolean;
  remaining_session_characters: number;
  reserved_session_credits: number;
  remaining_session_credits: number;
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

export default function ElevenLabsSettings({ onChanged }: { onChanged?: () => void }) {
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
      if (mounted.current) { setConnection(value); setNotice(success); onChanged?.(); }
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
  const selectedVoice = connection?.voices.find((voice) => voice.voice_id === connection.selected_voice_id);
  const selectedVoiceDescription = selectedVoice?.category === "generated"
    ? "Original designed voice selected."
    : selectedVoice?.category === "cloned"
      ? "Custom voice clone selected. Use a short sample to check how it sounds."
    : selectedVoice?.category === "premade"
      ? "Stock voice selected."
      : "Choose a voice for spoken answers.";

  return <section className="panel settings-panel elevenlabs-panel" aria-label="ElevenLabs connection">
    <div className="panel-header"><div><span className="eyebrow">SPOKEN ANSWERS</span><h2>ElevenLabs</h2></div>
      <span className={`runtime-state ${connection?.connected ? "safe" : "paused"}`}>{connection?.connected ? connection.generation_enabled ? "SPEECH ON REQUEST" : "LINKED · SPEECH OFF" : "NOT LINKED"}</span></div>
    <p>Choose a voice for spoken answers. Linking and changing the voice only read account information; they do not generate previews.</p>
    {!connection?.connected ? <form onSubmit={link} className="elevenlabs-link-form">
      <label htmlFor="elevenlabs-key">ELEVENLABS API KEY</label>
      <input ref={keyInput} id="elevenlabs-key" type="password" autoComplete="off" spellCheck={false} maxLength={256} placeholder="Paste your restricted API key" disabled={busy} />
      <small>Encrypted for your Windows account, outside this project. The key is cleared from this field when submitted.</small>
      <button className="button primary" type="submit" disabled={busy}>{busy ? "Reading account information…" : "Link account · no speech"}</button>
    </form> : <div className="elevenlabs-linked">
      <div className="runtime-row"><span>Available account credits</span><strong>{remaining === null ? "Not reported" : remaining.toLocaleString()}</strong></div>
      <small>This is the account allowance reported at the last check. Your key can have a smaller separate cap.</small>
      <label htmlFor="elevenlabs-voice">VOICE</label>
      <select id="elevenlabs-voice" value={connection.selected_voice_id ?? ""} disabled={busy} onChange={(event) => void update("elevenLabsSelectVoice", { voiceId: event.target.value }, "Voice choice saved without generating or playing audio.")}>
        <option value="" disabled>Choose a voice · no preview</option>
        {connection.voices.map((voice) => <option key={voice.voice_id} value={voice.voice_id}>{voice.name}</option>)}
      </select>
      <label className="preference-row"><span><strong>Enable spoken answers for this launch</strong><small>Listen buttons use ElevenLabs credits. Limited to 1,000 text characters and 1,000 conservatively reserved credits per launch; no automatic replies, retries, or top-ups.</small></span>
        <input type="checkbox" checked={connection.generation_enabled} disabled={busy || !connection.selected_voice_id || connection.subscription?.overage_status !== "disabled"}
          onChange={event => void update("elevenLabsSetGenerationEnabled", { enabled: event.target.checked, characterBudget: 1000 }, event.target.checked ? "Spoken answers enabled. Use Listen beside an answer." : "Spoken answers stopped and disabled.")} /></label>
      <div className="runtime-row"><span>Characters left this launch</span><strong>{connection.remaining_session_characters ?? 0}</strong></div>
      <div className="runtime-row"><span>Credit budget left this launch</span><strong>{connection.remaining_session_credits ?? 0}</strong></div>
      <div className="elevenlabs-actions">
        <button className="button secondary small" disabled={busy} onClick={() => void update("elevenLabsRefresh", {}, "Account information refreshed. No speech requested.")}>Refresh account information</button>
        <button className="button secondary small" disabled={busy} onClick={() => void update("elevenLabsDisconnect", {}, "Local key removed. You can revoke the API key separately in ElevenLabs.")}>Unlink locally</button>
      </div>
      {connection.subscription?.overage_status !== "disabled" && <p>Usage-based billing is not verified as disabled. Speech must remain blocked until that is resolved.</p>}
    </div>}
    <p className="elevenlabs-credit-note">Speech starts only when you press Listen. Text is sent to ElevenLabs for that request. {selectedVoiceDescription}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
