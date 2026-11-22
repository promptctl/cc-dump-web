import { parseSettings, type SettingsOf } from "@cc-dump/config/settings";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, object, parse, parsed, parseJson, value, type Reader, type Readers } from "@cc-dump/log/json";
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
// records to (docs/design/01-features.md, F1), its file made by the time this is answered.
export type Launched = { session: string; pane_id: PaneId; recording: string } & TmuxWindow;

// [LAW:types-are-the-program] A window, as tmux addresses one in a session (`session:window`), by ids, on the one tmux
// server that has it: `start_time` is that server's (#{start_time}). tmux numbers a new server's sessions and windows
// from 0 again, so after a restart the same ids name others, and only with the start time are they the ones they were.
export type TmuxWindow = { start_time: number; session_id: SessionId; window_id: WindowId };

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
  if (typeof value !== "string" || value.trim() === "" || /[\n\0]/.test(value)) throw new Malformed(`${name} must be a line of text that is not blank, got ${JSON.stringify(value)}`);
  return value;
}

const launch = object<Launch>({ session: parsed(kinds.string, sessionName), command: parsed(kinds.string, commandLine) });

export function parseLaunch(json: string): Launch {
  return parse(launch, parseJson(json, "launch"), "launch");
}

const launcher = object<Launcher>({
  settings: parsed(kinds.object, (settings) => parseSettings("launcher settings", launchSettingsTable, settings)),
  sessions: parsed(kinds.strings, (names) => sessions(names.map(sessionName))),
});

export function parseLauncher(json: string): Launcher {
  return parse(launcher, parseJson(json, "launcher"), "launcher");
}

// [LAW:parse-dont-validate] A list of session names as Sessions, or an error: tmux listed none.
export function sessions(names: string[]): Sessions {
  if (names.length === 0) throw new Malformed("sessions: tmux listed none");
  return names as Sessions;
}

export function parseLaunched(json: string): Launched {
  return parse(launched, parseJson(json, "launched"), "launched");
}

// [LAW:single-enforcer] The one rule for a number tmux writes, every id's and the start time's: decimal, with no
// leading zero, and exact as a JSON number. `@03` is no window's.
function tmuxNumber(value: string, what: string): number {
  const number = Number(value);
  if (!(/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(number))) throw new Malformed(`not ${what}: ${JSON.stringify(value)}`);
  return number;
}

// A session's id, `$1`, a window's, `@3`, or a pane's, `%7`, as tmux writes them. The library's own parsers are in the
// module that brings xterm.js with it, which node does not load, so the ids are read here.
const idKinds = { $: "session", "@": "window", "%": "pane" } as const;
function tmuxId<P extends keyof typeof idKinds>(prefix: P, value: string): `${P}${number}` {
  const what = `a tmux ${idKinds[prefix]} id`;
  if (!value.startsWith(prefix)) throw new Malformed(`not ${what}: ${JSON.stringify(value)}`);
  tmuxNumber(value.slice(1), what);
  return value as `${P}${number}`;
}
export type SessionId = `$${number}`;
export const sessionId = (value: string): SessionId => tmuxId("$", value);
export const windowId = (value: string): WindowId => tmuxId("@", value);
export const paneId = (value: string): PaneId => tmuxId("%", value);

// A tmux server's start time, as tmux writes it: seconds since the epoch.
export const startTime = (value: string): number => tmuxNumber(value, "a tmux server's start time");

// [LAW:single-enforcer] A window as a value holds it, read alike in a launch's answer and in the UI's view, which
// keeps its agent's.
const windowReaders: Readers<TmuxWindow> = {
  // Read by tmux's one rule, as the text tmux wrote it.
  start_time: parsed(kinds.integer, (seconds) => startTime(String(seconds))),
  session_id: parsed(kinds.string, sessionId),
  window_id: parsed(kinds.string, windowId),
};
export const tmuxWindow: Reader<TmuxWindow> = object(windowReaders);

const launched = object<Launched>({ session: parsed(kinds.string, sessionName), pane_id: parsed(kinds.string, paneId), recording: value(kinds.string), ...windowReaders });
