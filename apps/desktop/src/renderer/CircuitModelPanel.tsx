import { useState } from "react";
import type {
  PhotoCircuitComponent,
  PhotoCircuitModel,
  PhotoCircuitQuestion,
} from "../../../../packages/contracts/index";
import "./circuit-model.css";

type CircuitModelPanelProps = {
  model: PhotoCircuitModel | null;
  restored: boolean;
  busy: boolean;
  canAskCorrection: boolean;
  onAskCorrection: (question: string) => void;
};

function readableValue(component: PhotoCircuitComponent): string {
  if (component.value_si === null || !Number.isFinite(component.value_si)) return "Unknown";
  if (component.kind.toLowerCase().includes("resistor")) {
    const value = component.value_si;
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toPrecision(3)} MΩ`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toPrecision(3)} kΩ`;
    return `${value.toPrecision(4)} Ω`;
  }
  if (component.kind.toLowerCase().includes("capacitor")) {
    const value = component.value_si;
    if (Math.abs(value) < 1e-9) return `${(value * 1e12).toPrecision(3)} pF`;
    if (Math.abs(value) < 1e-6) return `${(value * 1e9).toPrecision(3)} nF`;
    if (Math.abs(value) < 1e-3) return `${(value * 1e6).toPrecision(3)} µF`;
    return `${value.toPrecision(4)} F`;
  }
  if (component.kind.toLowerCase().includes("inductor")) {
    const value = component.value_si;
    if (Math.abs(value) < 1e-3) return `${(value * 1e6).toPrecision(3)} µH`;
    return `${value.toPrecision(4)} H`;
  }
  if (component.kind.toLowerCase().includes("voltage") || component.kind.toLowerCase().includes("source")) {
    return `${component.value_si.toPrecision(4)} V`;
  }
  return component.value_si.toPrecision(4);
}

function provenance(component: PhotoCircuitComponent): string {
  const label = (source: string) => source.replaceAll("_", " ");
  return `Identity: ${label(component.source)} · Value: ${label(component.value_source)} · Wiring: ${label(component.connection_source)}`;
}

function questionLabel(question: PhotoCircuitQuestion): string {
  return question.target ? `${question.target}: ${question.issue}` : question.issue;
}

export default function CircuitModelPanel({ model, restored, busy, canAskCorrection, onAskCorrection }: CircuitModelPanelProps) {
  const [correction, setCorrection] = useState("");
  if (!model) return null;

  const { draft, simulation } = model;
  const submitCorrection = () => {
    const text = correction.trim();
    if (!text || busy || !canAskCorrection) return;
    setCorrection("");
    onAskCorrection(`Correct the remembered circuit using this clarification: ${text}`);
  };

  return <section className="panel circuit-model-panel" aria-label="Remembered circuit model">
    <div className="circuit-model-heading">
      <div>
        <span className="eyebrow">CIRCUIT MODEL</span>
        <h2>Remembered circuit</h2>
      </div>
      <span className={`circuit-model-badge ${restored ? "unverified" : "verified"}`}>
        {restored ? "UNVERIFIED RESTORE" : "CURRENT REVIEW"}
      </span>
    </div>
    <p className="circuit-model-summary">
      {draft.intended_function || "The working circuit draft is shown below."}
      {restored ? " Verify it with a fresh photo and question before relying on it." : ""}
    </p>

    {draft.components.length > 0 ? <div className="circuit-model-table-wrap">
      <table className="circuit-model-table">
        <caption>Components carried into the current circuit draft</caption>
        <thead><tr><th>Ref</th><th>Kind</th><th>Nodes</th><th>Value</th><th>Provenance</th></tr></thead>
        <tbody>{draft.components.map(component => <tr key={`${component.ref}-${component.nodes.join("-")}`}>
          <th scope="row">{component.ref}</th>
          <td>{component.kind}</td>
          <td>{component.nodes.map(node => node ?? "?").join(" ↔ ")}</td>
          <td>{readableValue(component)}</td>
          <td>{provenance(component)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="circuit-model-muted">No components are confirmed in this draft yet.</p>}

    {draft.questions.length > 0 && <div className="circuit-model-questions">
      <strong>Needs clarification before this model is complete</strong>
      <ul>{draft.questions.map((question, index) => <li key={`${question.target}-${index}`}>
        <span>{questionLabel(question)}</span><small>{question.request}</small>
      </li>)}</ul>
    </div>}

    {(draft.assumptions.length > 0 || draft.uncertainties.length > 0 || draft.unsupported.length > 0) && <div className="circuit-model-notes">
      {draft.assumptions.length > 0 && <div><strong>Assumptions</strong><ul>{draft.assumptions.slice(0, 5).map((item, index) => <li key={`assumption-${index}`}>{item}</li>)}</ul></div>}
      {draft.uncertainties.length > 0 && <div><strong>Uncertainties</strong><ul>{draft.uncertainties.slice(0, 5).map((item, index) => <li key={`uncertainty-${index}`}>{item}</li>)}</ul></div>}
      {draft.unsupported.length > 0 && <div><strong>Not represented</strong><ul>{draft.unsupported.slice(0, 5).map((item, index) => <li key={`unsupported-${index}`}>{item}</li>)}</ul></div>}
    </div>}

    <div className="circuit-model-simulation">
      <div className="circuit-model-subheading"><strong>SPICE result</strong><span>{simulation?.provenance === "ngspice_actual" ? "ngspice actual" : "not an actual simulation"}</span></div>
      {!simulation && <p className="circuit-model-muted">No simulation result is attached to this draft.</p>}
      {simulation && simulation.status !== "succeeded" && <div className="circuit-model-status blocked">
        <strong>Simulation {simulation.status === "blocked" ? "blocked" : "not available"}</strong>
        <p>{simulation.reason || "The circuit is not ready for a trustworthy SPICE run."}</p>
        <small>No node voltages were produced.</small>
      </div>}
      {simulation?.status === "succeeded" && <div className="circuit-model-status succeeded">
        <strong>Conditional predicted node voltages</strong>
        <p>These are simulator predictions from the remembered draft, not physical measurements.</p>
        {Object.keys(simulation.node_voltages_v).length > 0 ? <dl>{Object.entries(simulation.node_voltages_v).map(([node, voltage]) => <div key={node}><dt>{node}</dt><dd>{voltage.toPrecision(5)} V</dd></div>)}</dl> : <small>No node voltages were returned.</small>}
      </div>}
    </div>

    <div className="circuit-model-correction">
      <label htmlFor="circuit-model-correction">Correct something I remembered</label>
      <div><input id="circuit-model-correction" value={correction} onChange={event => setCorrection(event.target.value.slice(0, 1200))} placeholder="For example: R2 connects to node B, not ground." maxLength={1200} /><button type="button" className="button secondary small" onClick={submitCorrection} disabled={busy || !canAskCorrection || !correction.trim()}>Ask with correction</button></div>
      <small>{canAskCorrection ? "This asks in the same circuit context and updates the remembered model after the next review." : "Add a fresh image before asking for a correction to this restored draft."}</small>
    </div>
  </section>;
}
