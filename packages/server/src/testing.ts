import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyInfo } from "@cc-dump/proxy/format";
import { eventLog, serving } from "@cc-dump/log/testing";
import { onTestFinished } from "vitest";
import { createApp } from "./server.ts";
import type { NewWindow, Tmux } from "./tmux.ts";

export { TmuxRefused } from "./tmux.ts";

// The app server on a free port, until the test finishes: its launch settings in a directory of the test's own, a tmux
// with the sessions "work" and "play" that opens every window asked for (`opened`, in order), and a proxy at port 3344.
// `tmux` and `proxyInfo` replace either, to make it fail. `work` resolves with each event of the app's own work.
export async function app({ tmux = {}, proxyInfo = async () => ({ base_url: "http://127.0.0.1:3344" }) }: { tmux?: Partial<Tmux>; proxyInfo?: () => Promise<ProxyInfo> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, "cc-dump/launch.json");
  const opened: NewWindow[] = [];
  const fake: Tmux = {
    sessions: async () => ["work", "play"],
    newWindow: async (window) => (opened.push(window), { window_id: "@7", pane_id: "%9" }),
    ...tmux,
  };
  const events = eventLog();
  const { url, port, next } = await serving(createApp({ log: events.log, settingsPath, tmux: fake, proxyInfo }));
  const launch = (body: unknown) => fetch(`${url}/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { url, port, next, work: events.next, settingsPath, opened, launch };
}
