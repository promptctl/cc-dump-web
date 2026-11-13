import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createBrowserConnection } from "./connection/browser.ts";
import { settings } from "./settings.ts";
import "./index.css";

// The composition root: the one place that chooses how the UI reaches the backend.
const connection = createBrowserConnection();
window.addEventListener("storage", (event) => settings.changedElsewhere(event.key));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App connection={connection} />
  </StrictMode>,
);
