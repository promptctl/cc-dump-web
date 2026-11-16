import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingName, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";
import { eventLog, serving } from "@cc-dump/log/testing";
import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";
import { onTestFinished } from "vitest";
import { sessionId, startTime, windowId, type TmuxWindow } from "./format.ts";
import { createApp } from "./server.ts";
import { createTerminal } from "./terminal.ts";
import type { NewWindow, Tmux } from "./tmux.ts";

export { TmuxRefused } from "./tmux.ts";

// The app server on a free port, until the test finishes: its launch settings in a directory of the test's own, a tmux
// with the sessions "work" and "play" that opens every window asked for (`opened`, in order), and a proxy at port 3344 that
// makes a recording for each agent, one millisecond after the last, started in /work/project.
// `tmux`, `proxyInfo` and `proxyRecording` replace any, to make it fail. `work` resolves with each event of the app's own work.
export async function app({
  tmux = {},
  proxyInfo = async () => ({ base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/", recordings: "/recordings" }),
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
    newWindow: async (window) => (opened.push(window), { start_time: 1794801953, session_id: "$2", window_id: "@7", pane_id: "%9" }),
    ...tmux,
  };
  const events = eventLog();
  const { url, port, next } = await serving(createApp({ log: events.log, settingsPath, tmux: fake, proxyInfo, proxyRecording: makeRecording, directory: "/work/project" }));
  const launch = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/launch`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { url, port, next, work: events.next, settingsPath, opened, launch };
}

// A tmux server of the test's own, on a socket no other server uses, with `sessions`, reading no configuration, whose
// hooks and options would be the user's (a pane-died hook that respawns a dead pane). When the test finishes, each session
// still on the server is killed, and the server, started by its first session, exits with its last (exit-empty); the
// socket's file, which tmux leaves, is removed whether or not it did.
let servers = 0;
export function tmuxServer(...sessions: string[]) {
  const socketPath = `cc-dump-test-${process.pid}-${++servers}`;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-f", "/dev/null", "-L", socketPath, ...args], { encoding: "utf8", stdio: "pipe" });
  // The ids of the sessions on the server: none once it has exited, or when no session ever started it, which tmux says
  // as no server running, or none to connect to.
  const remaining = () => {
    try {
      return tmux("list-sessions", "-F", "#{session_id}").split("\n").filter(Boolean);
    } catch (error) {
      if (/no server running|error connecting to/.test(String((error as { stderr?: unknown }).stderr))) return [];
      throw error;
    }
  };
  onTestFinished(() => {
    try {
      for (const id of remaining()) tmux("kill-session", "-t", id);
    } finally {
      rmSync(join(tmuxSocketDir(), socketPath), { force: true });
    }
  });
  for (const session of sessions) tmux("new-session", "-d", "-s", session);
  // A session's current window.
  const windowOf = (session: string): TmuxWindow => {
    const [start_time, session_id, window_id] = tmux("display-message", "-p", "-t", `=${session}:`, "#{start_time} #{session_id} #{window_id}").trim().split(" ");
    return { start_time: startTime(start_time!), session_id: sessionId(session_id!), window_id: windowId(window_id!) };
  };
  return { socketPath, tmux, windowOf };
}

// The app server's terminal, alone, on a free port, on a tmux server of the test's own with `sessions`: `next` yields
// the events of serving it (its upgrades), `bridge` the terminal's own, and `clients` the clients attached to the
// server, by their sessions.
export async function terminal(...sessions: string[]) {
  const server = tmuxServer(...sessions);
  const own = eventLog();
  const served = await serving((_req, res) => res.writeHead(404).end(), createTerminal(own.log, { socketPath: server.socketPath }));
  const clients = () => server.tmux("list-clients", "-F", "#{client_session}").split("\n").filter(Boolean);
  return { ...served, ...server, bridge: own.next, clients };
}
