import { Component, type ReactNode } from "react";
import "./renderer-error-boundary.css";

type Props = { children: ReactNode; compact?: boolean };
type State = { failed: boolean; attempt: number };

export default class RendererErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Pick<State, "failed"> {
    return { failed: true };
  }

  private retry = () => {
    this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <main className={`renderer-recovery${this.props.compact ? " compact" : ""}`} role="alert">
        <section className="renderer-recovery-card">
          <span className="renderer-recovery-symbol" aria-hidden="true">Ω</span>
          <span className="renderer-recovery-kicker">OHM PATH · DISPLAY RECOVERY</span>
          <h1>This view needs a fresh start</h1>
          <p>Something interrupted the display. Your saved sessions remain on this computer. An unfinished step may need to be repeated.</p>
          <button type="button" onClick={this.retry}>Try again</button>
          <small>If the view still will not open, close and reopen Ohm Path.</small>
        </section>
      </main>;
    }
    return <div key={this.state.attempt} className="renderer-boundary-content">{this.props.children}</div>;
  }
}
