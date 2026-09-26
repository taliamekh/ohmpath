import { useMemo, useState } from "react";

type LabResult = Record<string, any>;
type Point = { x: number; y: number };

function fmt(value: unknown, digits = 4): string {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : "—";
}

function graphPath(points: Point[], minX: number, maxX: number, minY: number, maxY: number): string {
  const left = 66, top = 18, plotWidth = 664, plotHeight = 190;
  return points.map((point, index) => {
    const x = left + ((point.x - minX) / (maxX - minX || 1)) * plotWidth;
    const y = top + plotHeight - ((point.y - minY) / (maxY - minY || 1)) * plotHeight;
    return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function Plot({ title, xLabel, yLabel, points, xMax, yMax, xUnit, yUnit }: {
  title: string; xLabel: string; yLabel: string; points: Point[]; xMax: number; yMax: number; xUnit: string; yUnit: string;
}) {
  const path = graphPath(points, 0, xMax, 0, yMax);
  const left = 66, top = 18, plotWidth = 664, plotHeight = 190;
  const ticks = [0, 1, 2, 3, 4];
  return <div className="lab-plot-wrap">
    <div className="lab-plot-title"><strong>{title}</strong><span>NGSPICE SAMPLES</span></div>
    <svg className="lab-plot" viewBox="0 0 760 270" role="img" aria-label={`${title}; ${yLabel} plotted against ${xLabel}`}>
      {ticks.map((tick) => {
        const ratio = tick / 4;
        const x = left + ratio * plotWidth;
        const y = top + plotHeight - ratio * plotHeight;
        return <g key={tick}>
          <line x1={x} y1={top} x2={x} y2={top + plotHeight} className="lab-grid-line" />
          <line x1={left} y1={y} x2={left + plotWidth} y2={y} className="lab-grid-line" />
          <text x={x} y={top + plotHeight + 17} textAnchor="middle" className="lab-tick">{fmt(xMax * ratio, 3)}</text>
          <text x={left - 9} y={y + 3} textAnchor="end" className="lab-tick">{fmt(yMax * ratio, 3)}</text>
        </g>;
      })}
      <path d={path} className="lab-data-line" />
      <line x1={left} y1={top + plotHeight} x2={left + plotWidth} y2={top + plotHeight} className="lab-axis" />
      <line x1={left} y1={top} x2={left} y2={top + plotHeight} className="lab-axis" />
      <text x={left + plotWidth / 2} y="254" textAnchor="middle" className="lab-axis-label">{xLabel} ({xUnit})</text>
      <text x="14" y={top + plotHeight / 2} textAnchor="middle" className="lab-axis-label" transform={`rotate(-90 14 ${top + plotHeight / 2})`}>{yLabel} ({yUnit})</text>
    </svg>
  </div>;
}

export default function CircuitLabPage({ sid }: { sid: string }) {
  const [template, setTemplate] = useState<"rc" | "diode">("rc");
  const [resistance, setResistance] = useState("1000");
  const [capacitanceUf, setCapacitanceUf] = useState("1");
  const [supply, setSupply] = useState("3.3");
  const [result, setResult] = useState<LabResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isSuccess = result?.status === "succeeded" && result?.provenance === "ngspice_actual";
  const rcPoints = useMemo(() => (result?.trace ?? []).map((item: LabResult) => ({ x: Number(item.time_s), y: Number(item.voltage_v) })).filter((point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y)), [result]);
  const diodePoints = useMemo(() => (result?.sweep ?? []).map((item: LabResult) => ({ x: Number(item.supply_v), y: Number(item.current_a) * 1000 })).filter((point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y)), [result]);

  async function runLab() {
    if (!sid || busy) return;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      if (!window.ohmpath?.request) throw new Error("The local circuit laboratory is not available in this desktop build.");
      const payload = {
        sid,
        template,
        resistance_ohm: Number(resistance),
        capacitance_f: Number(capacitanceUf) * 1e-6,
        supply_v: Number(supply),
      };
      const response = await window.ohmpath.request("laboratory", payload);
      if (response && typeof response === "object" && (response as LabResult).error && !(response as LabResult).status) {
        const record = response as LabResult;
        throw new Error(record.message || String(record.error));
      }
      setResult(response as LabResult);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The local simulation request failed.");
    } finally {
      setBusy(false);
    }
  }

  const parameters = result?.parameters ?? {};
  const rcReference = result?.analytic_reference;
  const diodeModel = result?.shockley_reference;
  const rcEndTime = rcPoints.length > 1 ? Math.max(...rcPoints.map((point: Point) => point.x)) : 0;
  const rcTimeAxis = rcEndTime < 1e-6 ? { scale: 1e9, unit: "ns" } : rcEndTime < 1e-3 ? { scale: 1e6, unit: "µs" } : rcEndTime < 1 ? { scale: 1e3, unit: "ms" } : { scale: 1, unit: "s" };
  const canRun = Boolean(sid && Number.isFinite(Number(resistance)) && Number(resistance) >= 100 && Number(resistance) <= 1_000_000
    && Number.isFinite(Number(supply)) && Number(supply) > 0 && Number(supply) <= 5
    && (template !== "rc" || (Number.isFinite(Number(capacitanceUf)) && Number(capacitanceUf) >= 0.001 && Number(capacitanceUf) <= 1000)));

  return <div className="circuit-lab-page">
    <div className="page-heading"><div><div className="eyebrow">FIXED EDUCATIONAL MODELS</div><h1>Circuit laboratory</h1><p>Explore transient and nonlinear circuit behavior with bounded local ngspice templates.</p></div><span className="lab-simulation-stamp"><i /> SIMULATION ONLY<br /><small>NOT A PHYSICAL MEASUREMENT</small></span></div>
    <div className="lab-scope-banner"><strong>Predictions only</strong><span>These fixed educational models are not physical measurements, do not validate a real circuit, and never activate bench hardware.</span></div>

    <section className="panel lab-controls-panel">
      <div className="lab-template-tabs" role="group" aria-label="Circuit lab analysis">
        <button className={template === "rc" ? "active" : ""} onClick={() => { setTemplate("rc"); setResult(null); setError(""); }} disabled={busy}>RC transient</button>
        <button className={template === "diode" ? "active" : ""} onClick={() => { setTemplate("diode"); setResult(null); setError(""); }} disabled={busy}>Diode sweep</button>
      </div>
      <div className="lab-parameter-grid">
        <label><span>SERIES RESISTANCE</span><div><input type="number" min={100} max={1000000} step="100" value={resistance} disabled={busy} onChange={(event) => setResistance(event.target.value)} /><em>Ω</em></div><small>100 Ω to 1 MΩ · default 1 kΩ</small></label>
        {template === "rc" && <label><span>CAPACITANCE</span><div><input type="number" min={0.001} max={1000} step="0.1" value={capacitanceUf} disabled={busy} onChange={(event) => setCapacitanceUf(event.target.value)} /><em>µF</em></div><small>0.001 µF to 1000 µF · converted to farads locally</small></label>}
        <label><span>{template === "rc" ? "STEP SUPPLY" : "MAXIMUM SWEEP SUPPLY"}</span><div><input type="number" min={template === "rc" ? 0.1 : 0.000000001} max={5} step={template === "rc" ? 0.1 : 0.01} value={supply} disabled={busy} onChange={(event) => setSupply(event.target.value)} /><em>V</em></div><small>{template === "rc" ? "0.1 V to 5 V" : "Greater than 0 V through 5 V"}</small></label>
      </div>
      <div className="lab-run-row"><span>Only the selected fixed template is sent to the local simulator. No editable netlist or model instruction is accepted.</span><button className="button primary" onClick={runLab} disabled={!canRun || busy}>{busy ? "Running ngspice…" : "Run simulation"}<span>→</span></button></div>
      {error && <div className="inline-error" role="status">{error}</div>}
      {result && !isSuccess && <div className="lab-failure" role="status"><strong>No plotted simulation result</strong><span>Status: {result.status ?? "unknown"} · provenance: {result.provenance ?? "none"}</span><p>{result.error || "ngspice did not produce an actual successful result. No curve has been substituted."}</p></div>}
    </section>

    {isSuccess && <section className="panel lab-results-panel">
      <div className="lab-results-heading"><div><span className="eyebrow">LOCAL SOLVER RESULT</span><h2>{template === "rc" ? "RC step response" : "Educational diode DC sweep"}</h2></div><span className="lab-success-pill"><i /> NGSPICE ACTUAL</span></div>
      {template === "rc" && rcPoints.length > 1 && <>
        <Plot title="Capacitor node response" xLabel="Elapsed time" yLabel="Voltage" points={rcPoints.map((point: Point) => ({ x: point.x * rcTimeAxis.scale, y: point.y }))} xMax={rcEndTime * rcTimeAxis.scale} yMax={Math.max(Number(parameters.supply_v) * 1.08, ...rcPoints.map((point: Point) => point.y))} xUnit={rcTimeAxis.unit} yUnit="V" />
        <div className="lab-reference-grid"><div><small>TIME CONSTANT · τ = RC</small><strong>{fmt(rcReference?.time_constant_s, 6)} s</strong></div><div><small>SIMULATED 63.2% CROSSING</small><strong>{fmt(rcReference?.actual_63_2_percent_crossing_s, 6)} s</strong></div><div><small>IDEAL REFERENCE</small><strong>{rcReference?.crossing_within_2_percent ? "Within 2%" : "Outside 2%"}</strong></div></div>
      </>}
      {template === "diode" && diodePoints.length > 1 && <>
        <Plot title="Series current versus source sweep" xLabel="Supply voltage" yLabel="Diode current" points={diodePoints} xMax={Math.max(...diodePoints.map((point: Point) => point.x))} yMax={Math.max(0.01, ...diodePoints.map((point: Point) => point.y)) * 1.08} xUnit="V" yUnit="mA" />
        <div className="lab-model-note"><strong>{result.model_id}</strong><span>{diodeModel?.note ?? "Generic educational diode model; not vendor certified."}</span><small>{diodeModel?.checked_forward_points ?? 0} forward samples checked against the separate Shockley reference · max relative difference {fmt((diodeModel?.maximum_relative_current_difference ?? 0) * 100, 3)}%</small></div>
      </>}
      {((template === "rc" && rcPoints.length < 2) || (template === "diode" && diodePoints.length < 2)) && <div className="lab-failure"><strong>Trace data missing</strong><span>The solver reported success but did not return enough samples to plot.</span></div>}
      <div className="lab-result-meta"><span>Simulator {result.simulator_version ?? "unknown"}</span><span>Runtime {fmt(result.duration_s, 3)} s</span><span>Netlist SHA-256 {String(result.netlist_sha256 ?? "").slice(0, 16)}</span></div>
      {result.evidence_ids?.length > 0 && <div className="lab-evidence">SIMULATION EVIDENCE · {result.evidence_ids.join(" · ")}</div>}
      <div className="lab-limitations">{(result.limitations ?? []).map((item: string, index: number) => <p key={index}>{item}</p>)}</div>
    </section>}
    {!sid && <div className="inline-error">Select or create a session before running the local circuit lab.</div>}
  </div>;
}
