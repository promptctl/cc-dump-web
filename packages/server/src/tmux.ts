import { describe } from "@cc-dump/log/describe";
import { DependencyFailed, Malformed } from "@cc-dump/log/failure";
import {
  listSessions,
  newEmptyWindow,
  respawnPane,
  spawnTmux,
  TmuxClient,
  TmuxCommandError,
  TransportClosedError,
  UnrecognizedTmuxVersionError,
  UnsupportedTmuxVersionError,
  watchServerArgs,
  type SpawnOptions,
  type TmuxConnection,
} from "@promptctl/tmux-control-mode-js";
import { startTime, sessions, type Launched, type Sessions, type TmuxWindow } from "./format.ts";

// A window to open in a session: the command its pane runs, through the user's shell, in `cwd`, an absolute directory,
// with `env` set for it alone.
export type NewWindow = { session: string; command: string; cwd: string; env: Record<string, string> };

// The window opened, by its address, and its pane.
export type Window = Pick<Launched, keyof TmuxWindow | "pane_id">;

// [LAW:locality-or-seam] Everything the app server asks of tmux (docs/design/01-features.md, F1). Each call is one
// control-mode connection, opened for it and closed after, so none outlives the app server's restart on a change.
// Whatever tmux refuses, the attach included (no server, no sessions), rejects as TmuxRefused, in tmux's words.
export type Tmux = {
  // The names of the sessions on the server.
  sessions: () => Promise<Sessions>;
  // Opens the window as its session's current one, so a terminal attached to the session shows it.
  newWindow: (window: NewWindow) => Promise<Window>;
};

// tmux refused what it was asked, has no session by the name asked for, is older than a command needs, or ended the
// connection before answering; the message is tmux's own text where tmux gave one (a failed attach's: "no sessions",
// "error connecting to …" when no server runs).
export class TmuxRefused extends DependencyFailed {}

// [LAW:single-enforcer] The one way the app server connects to tmux, as `args` say: `options` picks the tmux server, as
// `tmux -L`/`-S` would, the user's default one when empty. Without TMUX, which an app server started in tmux inherits,
// `options` alone picks the server.
function connect(options: SpawnOptions, args: string[]): TmuxClient {
  return new TmuxClient(spawnTmux(args, { ...options, env: { ...(options.env ?? process.env), TMUX: undefined } }));
}

// A client attached to `window`'s session, as a terminal attached to it is, so the window can be shown through it and
// sized by it: the window terminal shows only its client's session's windows. `-E` leaves the session's environment as it
// was. By the session, never the window: tmux makes a window attached by its id the session's current one, in the user's
// own terminal too. The client attaches only on the server that started at the window's start time, so a window named on
// a server since restarted never touches the session that has its id now; a client left unattached exits.
// [LAW:no-ambient-temporal-coupling] The client is returned once it is attached, so the bridge welcomes a page only
// onto a window that is there: tmux runs a command sent after the attach once the attach has run, so its answer says the
// client is attached, and its failure that the window is gone.
export async function attach(options: SpawnOptions, { session_id, start_time }: TmuxWindow): Promise<TmuxClient> {
  const client = connect(options, ["-N", "if-shell", "-F", `#{==:#{start_time},${start_time}}`, `attach-session -E -t '${session_id}'`]);
  try {
    await client.execute("display-message -p ''");
    return client;
  } catch (error) {
    client.close();
    // The bridge tells the page the message alone, so it carries the failure's own words: tmux's, a refusal's message
    // alone, as the app server answers one, or the app server's own, with its causes.
    const failure = refused(error);
    const message = `attaching to session ${session_id} of the tmux server started at ${start_time}: ${failure instanceof TmuxRefused ? failure.message : describe(failure)}`;
    throw failure instanceof TmuxRefused ? new TmuxRefused(message, { cause: error }) : new Error(message, { cause: error });
  }
}

export function createTmux(options: SpawnOptions = {}): Tmux {
  const connected = async <T>(work: (client: TmuxConnection) => Promise<T>): Promise<T> => {
    // The library's watcher, attached to whichever session tmux picks, since the commands name their target: it changes
    // nothing the user sees, the session's environment included, and tmux does not refuse the attach while a launch's
    // window is empty.
    const client = connect(options, watchServerArgs());
    try {
      return await work(client);
    } catch (error) {
      throw refused(error);
    } finally {
      client.close();
    }
  };
  return {
    sessions: () => connected(async (client) => sessions((await listSessions(client)).map((session) => session.sessionName))),
    newWindow: ({ session, command, cwd, env }) =>
      connected(async (client) => {
        // tmux takes a session by id: a name it would also match as a prefix, a pattern, another session's id or a client.
        const named = (await listSessions(client)).find((found) => found.sessionName === session);
        if (named === undefined) throw new TmuxRefused(`no session named ${session}`);
        // [LAW:no-ambient-temporal-coupling] The server's start time, part of the window's address, is read before the
        // window opens: a read that fails after the command started would report a launch failed whose agent runs on.
        const start_time = startTime((await client.execute("display-message -p '#{start_time}'")).output[0]!);
        // The window opens empty and the command starts once its pane keeps a failed process, so a command that cannot
        // run leaves its pane, dead, showing why, where tmux would close the window. Any dead-pane message tmux prints
        // scrolls the screen, the shell's words with it, off into the pane's history: the pane prints none.
        const { windowId, paneId } = await newEmptyWindow(client, { sessionId: named.sessionId, select: true });
        try {
          await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
          await client.execute(`set-option -p -t %${paneId} remain-on-exit-format ''`);
          await respawnPane(client, paneId, { command, cwd, environment: env });
        } catch (error) {
          // A window whose command never started is the launch's to remove. One that stays is named in the failure,
          // which keeps its kind: tmux's refusal, in tmux's words, or the app server's failure.
          const failure = refused(error);
          await client.execute(`kill-window -t @${windowId}`).catch((removal: unknown) => {
            const stays = `its empty window @${windowId} stays: ${describe(removal)}`;
            throw failure instanceof TmuxRefused
              ? new TmuxRefused(`${failure.message}; ${stays}`, { cause: failure })
              : new AggregateError([failure, removal], `${describe(failure)}; ${stays}`);
          });
          throw failure;
        }
        return { start_time, session_id: `$${named.sessionId}`, window_id: `@${windowId}`, pane_id: `%${paneId}` };
      }),
  };
}

// [LAW:single-enforcer] The one place the library's errors become the seam's: a command tmux answered with an error, a
// tmux whose version a command does not run on, and a connection that ended first, whose reason is tmux's words when it
// gave some, in the bytes spawnTmux delivers them in, and an answer of tmux's that its format cannot take.
function refused(error: unknown): unknown {
  if (error instanceof Malformed) return new TmuxRefused(describe(error), { cause: error });
  if (error instanceof TmuxCommandError || error instanceof UnsupportedTmuxVersionError || error instanceof UnrecognizedTmuxVersionError)
    return new TmuxRefused(error.message, { cause: error });
  if (error instanceof TransportClosedError) return new TmuxRefused(error.reason === undefined ? error.message : Buffer.from(error.reason, "latin1").toString("utf8"), { cause: error });
  return error;
}
