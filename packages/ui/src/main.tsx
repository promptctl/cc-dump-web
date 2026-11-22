import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createBrowserConnection } from "./connection/browser.ts";
import { pageLog } from "./log.ts";
import { settings, storedSettings } from "./settings.ts";
import { changes, reportStored, storedLog } from "./stored.ts";
import "./index.css";

// The composition root: the one place that chooses how the UI reaches the backend, and where its own log is kept.
const connection = createBrowserConnection();
const page = pageLog();
reportStored(storedLog(page.log));
// Another tab's change to a Web Storage, read as a change to the settings, or to nothing the UI keeps across tabs.
window.addEventListener("storage", (event) => {
  if (changes(storedSettings, event)) settings.changedElsewhere();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App connection={connection} page={page} />
  </StrictMode>,
);
