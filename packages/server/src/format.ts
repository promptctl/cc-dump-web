import { parseSettings, type SettingsOf } from "@cc-dump/config/settings";
import { fields, jsonObject, parseJson } from "@cc-dump/log/json";

// [LAW:one-source-of-truth] What the app server and the UI say to each other about launching (docs/design/01-mvp.md,
// F1). Imports nothing that needs node, so the UI takes these types, and their parsers, from here.

// [LAW:one-source-of-truth] The launch settings (docs/design/01-mvp.md, F1, F11), in launch.json and in `GET /launch`'s
// answer alike: the settings the last launch asked for, which the next one starts from. They are stored before the
// launch is tried, so one that failed is tried again as it was asked. `session`: null until a launch names one; the agent
// command, a whole command line, `claude` until the user launches another.
export const launchSettingsTable = {
  session: { default: null, parse: (value: unknown) => (value === null ? null : sessionName(value)) },
  command: { default: "claude", parse: commandLine },
};
export type LaunchSettings = SettingsOf<typeof launchSettingsTable>;

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
// from the settings file alike. tmux runs a window's command as one line, with no NUL, which ends a C string, and a
// session target names a session by name.
export function sessionName(value: unknown): string {
  return oneLine(value, "session");
}

export function commandLine(value: unknown): string {
  return oneLine(value, "command");
}

function oneLine(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\n\0]/.test(value)) throw new Error(`${name} must be a line of text that is not blank, got ${JSON.stringify(value)}`);
  return value;
}

export function parseLaunch(json: string): Launch {
  const launch = jsonObject(parseJson(json, "launch"), "launch");
  return { session: sessionName(launch.session), command: commandLine(launch.command) };
}

export function parseLauncher(json: string): Launcher {
  const f = fields(parseJson(json, "launcher"), "launcher");
  return { settings: parseSettings("launcher settings", launchSettingsTable, f.object("settings")), sessions: sessions(f.strings("sessions").map(sessionName)) };
}

// [LAW:parse-dont-validate] A list of session names as Sessions, or an error: tmux listed none.
export function sessions(names: string[]): Sessions {
  if (names.length === 0) throw new Error("sessions: tmux listed none");
  return names as Sessions;
}

export function parseLaunched(json: string): Launched {
  const f = fields(parseJson(json, "launched"), "launched");
  return { session: sessionName(f.string("session")), window_id: f.string("window_id"), pane_id: f.string("pane_id") };
}

export function parseFailure(json: string): Failure {
  return { error: fields(parseJson(json, "failure"), "failure").string("error") };
}
