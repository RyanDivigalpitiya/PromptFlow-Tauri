import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./styles.css";

// Surface frontend failures in the dev terminal — a webview has no visible console.
function report(msg: string) {
  void invoke("log_msg", { msg }).catch(() => {});
}
window.addEventListener("error", (e) =>
  report(`error: ${e.message} @ ${e.filename}:${e.lineno}`),
);
window.addEventListener("unhandledrejection", (e) =>
  report(`unhandled rejection: ${String(e.reason)}`),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
