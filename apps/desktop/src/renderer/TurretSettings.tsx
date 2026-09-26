import { useEffect, useState } from "react";

type Status = { enabled: boolean; connected: boolean; motion_enabled: boolean; laser_enabled: boolean };

export default function TurretSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    window.ohmpath?.request("turretStatus").then(value => { if (active) setStatus(value as Status); })
      .catch(() => { if (active) setError("The turret preference could not be read."); });
    return () => { active = false; };
  }, []);
  async function change(enabled: boolean) {
    setBusy(true); setError("");
    try { setStatus(await window.ohmpath!.request("setTurretEnabled", { enabled }) as Status); }
    catch { setError("The turret preference could not be saved. Hardware stays locked."); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-panel" aria-label="Turret settings">
    <div className="panel-header"><div><span className="eyebrow">OPTIONAL HARDWARE</span><h2>Turret</h2></div><span className="runtime-state">{status?.enabled ? "SETUP NEEDED" : "OFF"}</span></div>
    <label className="preference-row"><span><strong>Use the turret</strong><small>Turn this off to work with cameras or uploaded images alone.</small></span><input type="checkbox" checked={status?.enabled === true} disabled={!status || busy} onChange={event => void change(event.target.checked)} /></label>
    <p className="registry-note">{status?.enabled ? "Saved for setup. The physical turret is not connected or verified; motion and laser remain locked." : "Turret off. Photo help and camera previews remain available."}</p>
    {error && <p className="companion-settings-error" role="alert">{error}</p>}
  </section>;
}
