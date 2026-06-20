import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./views/App.js";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in DOM");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
