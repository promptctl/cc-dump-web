import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingName, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";
import { eventLog, serving } from "@cc-dump/log/testing";
import { onTestFinished } from "vitest";
import { createApp } from "./server.ts";
import type { NewWindow, Tmux } from "./tmux.ts";

export { TmuxRefused } from "./tmux.ts";

// The app server on a free port, until the test finishes: its launch settings in a directory of the test's own, a tmux
// with the sessions "work" and "play" that opens every window asked for (`opened`, in order), and a proxy at port 3344 that
// makes a recording for each agent, one millisecond after the last, started in /work/project.
// `tmux`, `proxyInfo` and `proxyRecording` replace any, to make it fail. `work` resolves with each event of the app's own work.
export async function app({
  tmux = {},
  proxyInfo = async () => ({ base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/" }),
  proxyRecording,
}: { tmux?: Partial<Tmux>; proxyInfo?: () => Promise<ProxyInfo>; proxyRecording?: () => Promise<Listing> } = {}) {
  let made = 0;
  const makeRecording = proxyRecording ?? (async () => ({ name: recordingName(new Date(Date.UTC(2026, 10, 14) + made++)) }));
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
  const { url, port, next } = await serving(createApp({ log: events.log, settingsPath, tmux: fake, proxyInfo, proxyRecording: makeRecording, directory: "/work/project" }));
  const launch = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/launch`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { url, port, next, work: events.next, settingsPath, opened, launch };
}
