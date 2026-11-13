import type { Handler } from "@cc-dump/log";

// The app server restarts on every source change, so it holds nothing that must survive one.
export const app: Handler = (_req, res) => res.writeHead(404).end();
