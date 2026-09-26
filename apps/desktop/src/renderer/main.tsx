import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Companion from "./Companion";
import RendererErrorBoundary from "./RendererErrorBoundary";
import "./styles.css";
import "./journey-theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary compact={window.location.hash === "#companion"}>
      {window.location.hash === "#companion" ? <Companion /> : <App />}
    </RendererErrorBoundary>
  </React.StrictMode>,
);
