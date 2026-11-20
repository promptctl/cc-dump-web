import { parseSettings, type SettingsOf } from "@cc-dump/config/settings";
import { fields, jsonObject, parseJson } from "@cc-dump/log/json";
import type { PaneId, WindowId } from "@promptctl/tmux-control-mode-js/window-terminal";

// [LAW:one-source-of-truth] What the app server and the UI say to each other about launching (docs/design/01-features.md,
// F1). Imports nothing that needs node, so the UI takes these types, and their parsers, from here.

// [LAW:one-source-of-truth] The launch settings (docs/design/01-features.md, F1, F11), in launch.json and in `GET /launch`'s
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

// [LAW:single-enforcer] The session a launch starts in unless the user picks another: the one the last launch asked for,
// while tmux still has it, and otherwise tmux's first.
export function launchSession({ settings, sessions }: Launcher): string {
  return settings.session !== null && sessions.includes(settings.session) ? settings.session : sessions[0];
}

// `POST /launch`'s body: open a window in `session` running `command`, the agent's whole command line.
export type Launch = { session: string; command: string };

// `POST /launch`'s answer: the window opened, its pane, and `recording`, the name of the recording the agent's process
// records to (docs/design/01-features.md, F1), which exists once the process sends its first request (F7).
export type Launched = { session: string; pane_id: PaneId; recording: string } & TmuxWindow;

// [LAW:types-are-the-program] A window, as tmux addresses one in a session (`session:window`), by ids, on the one tmux
// server that has it: `start_time` is that server's (#{start_time}). tmux numbers a new server's sessions and windows
// from 0 again, so after a restart the same ids name others, and only with the start time are they the ones they were.
export type TmuxWindow = { start_time: number; session_id: SessionId; window_id: WindowId };

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
  return {
    session: sessionName(f.string("session")),
    pane_id: paneId(f.string("pane_id")),
    recording: f.string("recording"),
    start_time: startTime(String(f.integer("start_time"))),
    session_id: sessionId(f.string("session_id")),
    window_id: windowId(f.string("window_id")),
  };
}

// [LAW:single-enforcer] The one rule for a number tmux writes, every id's and the start time's: decimal, with no
// leading zero, and exact as a JSON number. `@03` is no window's.
function tmuxNumber(value: string, what: string): number {
  const number = Number(value);
  if (!(/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(number))) throw new RangeError(`not ${what}: ${JSON.stringify(value)}`);
  return number;
}

// A session's id, `$1`, a window's, `@3`, or a pane's, `%7`, as tmux writes them. The library's own parsers are in the
// module that brings xterm.js with it, which node does not load, so the ids are read here.
const idKinds = { $: "session", "@": "window", "%": "pane" } as const;
function tmuxId<P extends keyof typeof idKinds>(prefix: P, value: string): `${P}${number}` {
  const what = `a tmux ${idKinds[prefix]} id`;
  if (!value.startsWith(prefix)) throw new RangeError(`not ${what}: ${JSON.stringify(value)}`);
  tmuxNumber(value.slice(1), what);
  return value as `${P}${number}`;
}
export type SessionId = `$${number}`;
export const sessionId = (value: string): SessionId => tmuxId("$", value);
export const windowId = (value: string): WindowId => tmuxId("@", value);
export const paneId = (value: string): PaneId => tmuxId("%", value);

// A tmux server's start time, as tmux writes it: seconds since the epoch.
export const startTime = (value: string): number => tmuxNumber(value, "a tmux server's start time");

export function parseFailure(json: string): Failure {
  return { error: fields(parseJson(json, "failure"), "failure").string("error") };
}
