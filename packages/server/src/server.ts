import { loggedIn, type Handler, type Log, type TraceId } from "@cc-dump/log";
import { bodyOf, json, routes, type Route } from "@cc-dump/log/answer";
import { ROUTES } from "@cc-dump/log/wire";
import { agentBaseUrl, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";
import { parseLaunch, type Launched, type Launcher } from "./format.ts";
import { launchSettings } from "./settings.ts";
import type { Tmux } from "./tmux.ts";

// What the app server works with, chosen by its composition root (main.ts): where the launch settings are kept, the
// tmux server, the running proxy (what it says it is, and the recording it makes for an agent), and `directory`, the one
// the app was started in, where every agent it launches starts. `logs`: the app server's log lines (processLog), which
// `GET /logs` serves to the logs panel (docs/design/01-features.md, F9).
export type Parts = {
  log: Log;
  logs: Route;
  settingsPath: string;
  tmux: Tmux;
  proxyInfo: () => Promise<ProxyInfo>;
  proxyRecording: () => Promise<Listing>;
  directory: string;
};

// The app server restarts on every source change, so it holds nothing that must survive one: the settings are on disk,
// and tmux and the proxy are asked again on each request.
export function createApp({ log, logs, settingsPath, tmux, proxyInfo, proxyRecording, directory }: Parts): Handler {
  // The launch settings, and on their event which of them launch.json set, `file_keys` (null: there is no file), the
  // rest being their defaults.
  const readSettings = async (trace_id: TraceId) =>
    (
      await loggedIn(log, trace_id, "launch_settings", { path: settingsPath }, async () => launchSettings.read(settingsPath), ({ file_keys }) => ({ file_keys }))
    ).settings;

  // `GET /launch` (docs/design/01-features.md, F1): what a launch starts from.
  const launcher: Route = async (_req, { trace_id }) =>
    json({
      settings: await readSettings(trace_id),
      sessions: await loggedIn(log, trace_id, "tmux_sessions", {}, tmux.sessions, (sessions) => ({ sessions: sessions.length })),
    } satisfies Launcher);

  // `POST /launch`: stores the settings asked for, then opens the agent's window, pointed at the running proxy by a path
  // of its own, which is how the proxy tells its process's requests from every other's (`agentBaseUrl`). The command is
  // run as the user wrote it. The proxy makes the recording that process will be, since it is the proxy that writes it.
  const launch: Route = async (req, { trace_id }) => {
    const { session, command } = await bodyOf(req, parseLaunch);
    launchSettings.write(settingsPath, { session, command });
    const { base_url } = await loggedIn(log, trace_id, "proxy_info", {}, proxyInfo, (info) => info);
    const { name: recording } = await loggedIn(log, trace_id, "proxy_recording", {}, proxyRecording, ({ name }) => ({ recording: name }));
    const window = await loggedIn(
      log,
      trace_id,
      "launch",
      { session, command, directory, base_url, recording, settings_path: settingsPath },
      () => tmux.newWindow({ session, command, cwd: directory, env: { ANTHROPIC_BASE_URL: agentBaseUrl(base_url, recording) } }),
      (window) => window,
    );
    return json({ session, ...window, recording } satisfies Launched);
  };

  return routes({ [ROUTES.launch]: { GET: launcher, POST: launch }, [ROUTES.logs]: { GET: logs } });
}
