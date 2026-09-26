import { useEffect, useRef, useState } from "react";

type Sample = { yaw_deg: number; pitch_deg: number; dx_px: number; dy_px: number };
type CalibrationSource = "synthetic" | "user_supplied";
type CalibrationResult = { circuit_revision: string; source: CalibrationSource; candidate: Record<string, any> };

const SAMPLE_LIMIT = 12_000;
const SAMPLE_MAX = 64;

const syntheticExample = {
  fit_samples: [
    { yaw_deg: 0, pitch_deg: 0, dx_px: 0, dy_px: 0 },
    { yaw_deg: 1, pitch_deg: 0, dx_px: 12, dy_px: -2 },
    { yaw_deg: 0, pitch_deg: 1, dx_px: 3, dy_px: 15 },
    { yaw_deg: -1, pitch_deg: -1, dx_px: -15, dy_px: -13 },
  ],
  validation_samples: [
    { yaw_deg: 2, pitch_deg: 1, dx_px: 27, dy_px: 11 },
    { yaw_deg: -1, pitch_deg: 2, dx_px: -6, dy_px: 32 },
  ],
};

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "Not reported";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function unpack<T>(raw: unknown): T {
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, any>;
    if (value.error) throw new Error(value.message || String(value.error));
    if (Object.prototype.hasOwnProperty.call(value, "data")) return value.data as T;
  }
  return raw as T;
}

function readSamples(text: string): { fit_samples: Sample[]; validation_samples: Sample[] } {
  if (text.length > SAMPLE_LIMIT) throw new Error(`Keep the sample JSON under ${SAMPLE_LIMIT.toLocaleString()} characters.`);
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Enter valid JSON with fit_samples and validation_samples arrays."); }
  if (!parsed || !Array.isArray(parsed.fit_samples) || !Array.isArray(parsed.validation_samples)) {
    throw new Error("Include both fit_samples and validation_samples arrays.");
  }
  if (parsed.fit_samples.length < 3 || parsed.fit_samples.length > SAMPLE_MAX || parsed.validation_samples.length < 1 || parsed.validation_samples.length > SAMPLE_MAX) {
    throw new Error(`Provide 3–${SAMPLE_MAX} fit observations and 1–${SAMPLE_MAX} separate validation observations.`);
  }
  for (const [group, samples] of [["fit_samples", parsed.fit_samples], ["validation_samples", parsed.validation_samples]] as const) {
    for (const [index, sample] of samples.entries()) {
      if (!sample || ["yaw_deg", "pitch_deg", "dx_px", "dy_px"].some((key) => typeof sample[key] !== "number" || !Number.isFinite(sample[key]))) {
        throw new Error(`${group}[${index}] needs finite yaw_deg, pitch_deg, dx_px, and dy_px numbers.`);
      }
    }
  }
  return { fit_samples: parsed.fit_samples, validation_samples: parsed.validation_samples };
}

async function request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  if (!window.ohmpath?.request) throw new Error("The local bench connection is unavailable.");
  return unpack<T>(await window.ohmpath.request(action, payload));
}

export default function CalibrationPanel({ sid }: { sid: string }) {
  const [source, setSource] = useState<CalibrationSource>("user_supplied");
  const [samplesText, setSamplesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const generationRef = useRef(0);
  const sidRef = useRef(sid);
  sidRef.current = sid;

  useEffect(() => {
    generationRef.current += 1;
    setResult(null);
    setError("");
    setBusy(false);
    setSamplesText("");
    setSource("user_supplied");
  }, [sid]);

  function loadSyntheticExample() {
    setSource("synthetic");
    setSamplesText(JSON.stringify(syntheticExample, null, 2));
    setResult(null);
    setError("");
  }

  async function checkSamples() {
    if (!sid || busy) return;
    setError("");
    setResult(null);
    let samples: ReturnType<typeof readSamples>;
    try { samples = readSamples(samplesText); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Sample JSON is invalid."); return; }

    const requestSid = sid;
    const generation = ++generationRef.current;
    setBusy(true);
    try {
      const session = await request<Record<string, any>>("session", { sid: requestSid });
      const circuitRevision = session?.revisions?.circuit_revision;
      if (typeof circuitRevision !== "string" || !circuitRevision) throw new Error("The active circuit revision is unavailable.");
      const response = await request<Record<string, any>>("fitCalibration", {
        sid: requestSid,
        circuit_revision: circuitRevision,
        data_source: source,
        fit_samples: samples.fit_samples,
        validation_samples: samples.validation_samples,
      });
      const current = await request<Record<string, any>>("session", { sid: requestSid });
      if (generation !== generationRef.current || requestSid !== sidRef.current) return;
      if (current?.revisions?.circuit_revision !== circuitRevision) {
        setError("The circuit changed while calibration was being checked. Run the check again on the current revision.");
        return;
      }
      const candidate = (response?.candidate && typeof response.candidate === "object" ? response.candidate : response) as Record<string, any>;
      setResult({ circuit_revision: circuitRevision, source, candidate });
    } catch (problem) {
      if (generation === generationRef.current && requestSid === sidRef.current) setError(problem instanceof Error ? problem.message : "Calibration samples could not be checked.");
    } finally {
      if (generation === generationRef.current && requestSid === sidRef.current) setBusy(false);
    }
  }

  const candidate = result?.candidate;
  const jacobian = candidate?.calibration?.jacobian_px_per_degree;
  const fitResiduals = candidate ? { rms_px: candidate.fit_rms_residual_px } : null;
  const heldOutResiduals = candidate ? { rms_px: candidate.validation_rms_residual_px, maximum_px: candidate.validation_max_residual_px } : null;

  return <section className="panel calibration-panel">
    <div className="device-section-head calibration-heading"><div><span className="eyebrow">OFFLINE DATA CHECK</span><h2>Yaw/pitch calibration candidate</h2><p>Review the local motion-to-image mapping and held-out residuals without applying a calibration.</p></div><span className="calibration-pending">PHYSICAL VERIFICATION PENDING</span></div>
    <div className="calibration-boundary"><strong>Candidate only</strong><span>This check does not calibrate a live camera, change a calibration revision, or enable hardware. No physical verification is claimed.</span></div>
    <div className="calibration-controls">
      <label><span>DATA SOURCE</span><select value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as CalibrationSource); setResult(null); }}><option value="user_supplied">User-supplied observations</option><option value="synthetic">Synthetic demonstration data</option></select></label>
      <button className="button secondary" onClick={loadSyntheticExample} disabled={busy}>Load synthetic example · 4 fit / 2 held out</button>
    </div>
    {source === "synthetic" && <p className="calibration-synthetic-note">Synthetic ground truth: J = [[12, 3], [-2, 15]] px/degree. The 4 fitting observations and 2 held-out observations are generated examples, not camera measurements.</p>}
    <label className="calibration-json-field"><span>OBSERVATIONS · JSON · MAX {SAMPLE_LIMIT.toLocaleString()} CHARACTERS</span><textarea value={samplesText} maxLength={SAMPLE_LIMIT} spellCheck={false} onChange={(event) => { setSamplesText(event.target.value.slice(0, SAMPLE_LIMIT)); setResult(null); }} placeholder={'{\n  "fit_samples": [{ "yaw_deg": 0, "pitch_deg": 0, "dx_px": 0, "dy_px": 0 }],\n  "validation_samples": [{ "yaw_deg": 1, "pitch_deg": 1, "dx_px": 15, "dy_px": 13 }]\n}'} disabled={busy} /></label>
    <p className="calibration-format-note">Each row is one paired angular command and observed pixel displacement. Keep validation observations separate; the checker does not treat them as fit data.</p>
    <div className="calibration-actions"><button className="button primary" onClick={() => void checkSamples()} disabled={!sid || busy || !samplesText.trim()}>{busy ? "Checking samples…" : "Check calibration samples"}<span>→</span></button><span>Uses the current circuit revision as context only; it does not apply the returned candidate.</span></div>
    {error && <div className="inline-error" role="status">{error}</div>}
    {result && candidate && <div className="calibration-result" aria-live="polite">
      <div className="calibration-result-head"><strong>Candidate result</strong><span className="revision-tag">CIRCUIT {result.circuit_revision}</span></div>
      <div className="calibration-summary-grid"><div><span>STATUS</span><strong>{String(candidate.status ?? "Not reported")}</strong></div><div><span>SOURCE</span><strong>{result.source === "synthetic" ? "Synthetic demonstration" : "User supplied"}</strong></div><div><span>HARDWARE</span><strong>{candidate.hardware_armed === false ? "Disabled" : "Not enabled by this candidate check"}</strong></div></div>
      <div className="calibration-result-grid"><div><span>JACOBIAN · PX / DEGREE</span><pre>{pretty(jacobian)}</pre></div><div><span>FIT RESIDUALS · PX</span><pre>{pretty(fitResiduals)}</pre></div><div><span>HELD-OUT RESIDUALS · PX</span><pre>{pretty(heldOutResiduals)}</pre></div><div><span>REASONS</span><pre>{pretty(candidate.rejection_reasons)}</pre></div></div>
      <p>Physical verification: <strong>{String(candidate.physical_verification ?? "pending")}</strong>. This candidate remains unapplied.</p>
    </div>}
  </section>;
}
