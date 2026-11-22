import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createBrowserConnection } from "./connection/browser.ts";
import { pageLog } from "./log.ts";
import { restoredSettings, settings, settingsItem, useSettings } from "./settings.ts";
import { keepStored, storedLog } from "./stored.ts";
import { restoredView, useView, viewItem } from "./view/state.ts";
import "./index.css";

// The composition root: the one place that chooses how the UI reaches the backend, and where its own log is kept.
const connection = createBrowserConnection();
const page = pageLog();

// [LAW:effects-at-boundaries] The stores the page keeps, each read as its module loaded, reported here, and kept from
// here on as it changes.
const stored = storedLog(page.log);
stored.read("view", restoredView.read);
stored.read("settings", restoredSettings.read);
keepStored(useView, () => sessionStorage, viewItem, stored.refused("view"));
keepStored(useSettings, () => localStorage, settingsItem, stored.refused("settings"));
window.addEventListener("storage", (event) => {
  if (event.key === settingsItem.name) stored.read("settings", settings.changedElsewhere());
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App connection={connection} page={page} />
  </StrictMode>,
);
