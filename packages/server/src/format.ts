import { jsonObject, parseJson } from "@cc-dump/log/json";

// [LAW:one-source-of-truth] What the app server and the UI say to each other about launching (docs/design/01-mvp.md,
// F1). Imports nothing that needs node, so the UI takes these types, and their parsers, from here.

// The settings the last launch was made with, which the next one starts from. `session`: null until a launch names one.
export type LaunchSettings = { session: string | null; command: string };

// The names of the sessions on a tmux server: at least one, since tmux was attached to one to list them.
export type Sessions = [string, ...string[]];

// `GET /launch`: the settings, and the sessions on the user's tmux server.
export type Launcher = { settings: LaunchSettings; sessions: Sessions };

// `POST /launch`'s body: open a window in `session` running `command`, the agent's whole command line.
export type Launch = { session: string; command: string };

// `POST /launch`'s answer: the window opened, by the ids tmux gave it.
export type Launched = { session: string; window_id: string; pane_id: string };

// Every refused or failed request's answer: why, in words the user is shown as they are (tmux's own, when tmux refused).
export type Failure = { error: string };

// [LAW:parse-dont-validate] [LAW:single-enforcer] Each value of a launch is parsed here, from the request's body and
// from the settings file alike. tmux runs a window's command as one line, and a session target names a session by name.
export function sessionName(value: unknown): string {
  return oneLine(value, "session");
}

export function commandLine(value: unknown): string {
  return oneLine(value, "command");
}

function oneLine(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\n")) throw new Error(`${name} must be a non-empty line of text, got ${JSON.stringify(value)}`);
  return value;
}

export function parseLaunch(json: string): Launch {
  const launch = jsonObject(parseJson(json, "launch"), "launch");
  return { session: sessionName(launch.session), command: commandLine(launch.command) };
}

export function parseLauncher(json: string): Launcher {
  const launcher = jsonObject(parseJson(json, "launcher"), "launcher");
  const settings = jsonObject(launcher.settings, "launcher settings");
  if (!Array.isArray(launcher.sessions)) throw new Error("launcher: sessions is not a list");
  return {
    settings: { session: settings.session === null ? null : sessionName(settings.session), command: commandLine(settings.command) },
    sessions: sessions(launcher.sessions.map(sessionName)),
  };
}

// [LAW:parse-dont-validate] A list of session names as Sessions, or an error: tmux listed none.
export function sessions(names: string[]): Sessions {
  if (names.length === 0) throw new Error("sessions: tmux listed none");
  return names as Sessions;
}

export function parseLaunched(json: string): Launched {
  const launched = jsonObject(parseJson(json, "launched"), "launched");
  return { session: sessionName(launched.session), window_id: text(launched.window_id, "window_id"), pane_id: text(launched.pane_id, "pane_id") };
}

export function parseFailure(json: string): Failure {
  return { error: text(jsonObject(parseJson(json, "failure"), "failure").error, "error") };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is not a string`);
  return value;
}
