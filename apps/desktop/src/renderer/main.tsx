import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Companion from "./Companion";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash === "#companion" ? <Companion /> : <App />}
  </React.StrictMode>,
);
