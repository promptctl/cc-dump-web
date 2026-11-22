import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createBrowserConnection } from "./connection/browser.ts";
import { pageLog } from "./log.ts";
import { settings } from "./settings.ts";
import { reportStored, storedLog } from "./stored.ts";
import "./index.css";

// The composition root: the one place that chooses how the UI reaches the backend, and where its own log is kept.
const connection = createBrowserConnection();
const page = pageLog();
reportStored(storedLog(page.log));
window.addEventListener("storage", (event) => settings.changedElsewhere(event.key));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App connection={connection} page={page} />
  </StrictMode>,
);
