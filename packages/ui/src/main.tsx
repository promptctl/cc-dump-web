import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createBrowserConnection } from "./connection/browser.ts";
import "./index.css";

// The composition root: the one place that chooses how the UI reaches the backend.
const connection = createBrowserConnection();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App connection={connection} />
  </StrictMode>,
);
