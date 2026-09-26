import { useEffect, useState } from "react";

type Activity = "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";
type CompanionState = { activity: Activity; caption: string; reducedMotion: boolean };

const activityLabels: Record<Activity, string> = {
  idle: "Guide idle",
  listening: "Listening",
  thinking: "Checking",
  speaking: "Speaking",
  paused: "Paused",
  error: "Connection issue",
};

export default function Companion() {
  const [state, setState] = useState<CompanionState>({ activity: "idle", caption: "", reducedMotion: false });
  const [hiding, setHiding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = window.ohmpathCompanion?.onState((next) => {
      setState({
        activity: next.activity,
        caption: typeof next.caption === "string" ? next.caption.slice(0, 500) : "",
        reducedMotion: next.reducedMotion === true,
      });
    });
    return () => unsubscribe?.();
  }, []);

  async function hide() {
    if (!window.ohmpathCompanion || hiding) return;
    setHiding(true);
    setError("");
    try { await window.ohmpathCompanion.hide(); }
    catch { setError("The companion window could not be hidden."); setHiding(false); }
  }

  return <main className={`companion-window ${state.reducedMotion ? "companion-reduce-motion" : ""}`}>
    <header className="companion-head">
      <div className="companion-brand"><span className={`companion-status-dot ${state.activity}`} /><div><strong>Ohm Path</strong><small>DESKTOP COMPANION</small></div></div>
      <button className="companion-hide" onClick={() => void hide()} disabled={hiding} aria-label="Hide floating companion" title="Hide companion">×</button>
    </header>
    <section className="companion-center" aria-label="Guide activity">
      <div className={`companion-orbit ${state.activity}`} aria-hidden="true"><span className="companion-orbit-ring" /><span className="companion-orbit-core"><i /><b /></span><span className="companion-orbit-star">✦</span></div>
      <div className={`companion-activity ${state.activity}`} role="status"><i />{activityLabels[state.activity]}</div>
      <p className="companion-identity">Neutral guide placeholder<br /><span>Frieren art and voice pending</span></p>
    </section>
    <section className="companion-caption" aria-live="polite" aria-label="Current caption">
      <span className="eyebrow">LIVE CAPTION</span>
      <p>{state.caption || "No caption right now."}</p>
    </section>
    {error && <p className="companion-error" role="alert">{error}</p>}
    <footer>Follows Ohm Path’s current guide state · no bench controls</footer>
  </main>;
}
