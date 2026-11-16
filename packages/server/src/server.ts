import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { loggedIn, type Handler, type Log, type Work } from "@cc-dump/log";
import { describe } from "@cc-dump/log/describe";
import { agentBaseUrl, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";
import { parseLaunch, type Failure, type Launched, type Launcher } from "./format.ts";
import { fromThisMachine } from "./origin.ts";
import { launchSettings } from "./settings.ts";
import { TmuxRefused, type Tmux } from "./tmux.ts";

// What the app server works with, chosen by its composition root (main.ts): where the launch settings are kept, the
// tmux server, the running proxy (what it says it is, and the recording it makes for an agent), and `directory`, the one
// the app was started in, where every agent it launches starts. `logs`: the app server's log lines (processLog), which
// `GET /logs` serves to the logs panel (docs/design/01-mvp.md, F9).
export type Parts = {
  log: Log;
  logs: Handler;
  settingsPath: string;
  tmux: Tmux;
  proxyInfo: () => Promise<ProxyInfo>;
  proxyRecording: () => Promise<Listing>;
  directory: string;
};

// A request the app server refuses, answered with `status` and the refusal's message.
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

type Answer = (req: IncomingMessage, work: Work) => Promise<unknown>;

// The app server restarts on every source change, so it holds nothing that must survive one: the settings are on disk,
// and tmux and the proxy are asked again on each request.
export function createApp({ log, logs, settingsPath, tmux, proxyInfo, proxyRecording, directory }: Parts): Handler {
  // The launch settings, and on their event which of them launch.json set, `file_keys` (null: there is no file), the
  // rest being their defaults.
  const readSettings = async (trace_id: string) =>
    (
      await loggedIn(log, trace_id, "launch_settings", { path: settingsPath }, async () => launchSettings.read(settingsPath), ({ file_keys }) => ({ file_keys }))
    ).settings;

  // `GET /launch` (docs/design/01-mvp.md, F1): what a launch starts from.
  const launcher: Answer = async (_req, { trace_id }): Promise<Launcher> => ({
    settings: await readSettings(trace_id),
    sessions: await loggedIn(log, trace_id, "tmux_sessions", {}, tmux.sessions, (sessions) => ({ sessions: sessions.length })),
  });

  // `POST /launch`: stores the settings asked for, then opens the agent's window, pointed at the running proxy by a path
  // of its own, which is how the proxy tells its process's requests from every other's (`agentBaseUrl`). The command is
  // run as the user wrote it. The proxy makes the recording that process will be, since it is the proxy that writes it.
  const launch: Answer = async (req, { trace_id }): Promise<Launched> => {
    const { session, command } = parsed(parseLaunch, (await buffer(req)).toString());
    launchSettings.write(settingsPath, { session, command });
    const { base_url } = await loggedIn(log, trace_id, "proxy_info", {}, proxyInfo, (info) => info).catch((error: unknown) => {
      throw new Refused(502, `The proxy did not say where agents reach it: ${describe(error)}`, { cause: error });
    });
    const { name: recording } = await loggedIn(log, trace_id, "proxy_recording", {}, proxyRecording, ({ name }) => ({ recording: name })).catch((error: unknown) => {
      throw new Refused(502, `The proxy did not make a recording for the agent: ${describe(error)}`, { cause: error });
    });
    const window = await loggedIn(
      log,
      trace_id,
      "launch",
      { session, command, directory, base_url, recording, settings_path: settingsPath },
      () => tmux.newWindow({ session, command, cwd: directory, env: { ANTHROPIC_BASE_URL: agentBaseUrl(base_url, recording) } }),
      (window) => window,
    );
    return { session, ...window, recording };
  };

  const routes: Record<string, Partial<Record<string, Answer>>> = { "/launch": { GET: launcher, POST: launch } };

  return (req, res, work) => {
    // [LAW:single-enforcer] Every answer, any route's: the browser's origin is the UI's, and security is a non-goal
    // (docs/design/01-mvp.md).
    res.setHeader("access-control-allow-origin", "*");
    if (!fromThisMachine(req.headers.origin)) return failed(res, work, new Refused(403, `A page at ${req.headers.origin} cannot launch agents`));
    const pathname = new URL(req.url!, "http://server").pathname;
    // The log is a stream, not an answer.
    if (pathname === "/logs") return logs(req, res, work);
    const route = routes[pathname];
    if (route === undefined) return void res.writeHead(404).end();
    const allow = Object.keys(route).join(", ");
    // The browser's preflight of a JSON POST from the UI's origin.
    if (req.method === "OPTIONS") return void res.writeHead(204, { "access-control-allow-methods": allow, "access-control-allow-headers": "content-type" }).end();
    const answer = route[req.method!];
    if (answer === undefined) return void res.writeHead(405, { allow }).end();
    answer(req, work).then(
      (body) => json(res, 200, body),
      (error: unknown) => failed(res, work, error),
    );
  };
}

// [LAW:nothing-unseen] Every answer that is not the request's is its failure, on its event as on its answer.
function failed(res: ServerResponse, work: Work, error: unknown) {
  const { status, message } = refusal(error);
  work.fail(error);
  json(res, status, { error: message } satisfies Failure);
}

// [LAW:single-enforcer] The one place an error becomes an answer: a request refused says why, and tmux refusing is a
// dependency failing, in tmux's words; anything else is the app server failing.
function refusal(error: unknown): { status: number; message: string } {
  if (error instanceof Refused) return error;
  if (error instanceof TmuxRefused) return { status: 502, message: error.message };
  return { status: 500, message: describe(error) };
}

// A request body the app server cannot take is refused, saying why.
function parsed<T>(parse: (text: string) => T, text: string): T {
  try {
    return parse(text);
  } catch (error) {
    throw new Refused(400, describe(error), { cause: error });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
