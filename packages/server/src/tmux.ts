import { describe } from "@cc-dump/log/describe";
import {
  listSessions,
  newEmptyWindow,
  respawnPane,
  spawnTmux,
  TmuxClient,
  TmuxCommandError,
  TransportClosedError,
  watchServerArgs,
  type SpawnOptions,
  type TmuxConnection,
} from "@promptctl/tmux-control-mode-js";
import { sessions, type Sessions } from "./format.ts";

// A window to open in a session: the command its pane runs, through the user's shell, with `env` set for it alone.
export type NewWindow = { session: string; command: string; env: Record<string, string> };

// The window opened, by the ids tmux gave it.
export type Window = { window_id: string; pane_id: string };

// [LAW:locality-or-seam] Everything the app server asks of tmux (docs/design/01-mvp.md, F1). Each call is one
// control-mode connection, opened for it and closed after, so none outlives the app server's restart on a change.
// Whatever tmux refuses, the attach included (no server, no sessions), rejects as TmuxRefused, in tmux's words.
export type Tmux = {
  // The names of the sessions on the server.
  sessions: () => Promise<Sessions>;
  // Opens the window as its session's current one, so a terminal attached to the session shows it.
  newWindow: (window: NewWindow) => Promise<Window>;
};

// tmux refused what it was asked, has no session by the name asked for, or ended the connection before answering; the
// message is tmux's own text where tmux gave one (a failed attach's: "no sessions", "error connecting to …" when no
// server runs).
export class TmuxRefused extends Error {}

// `options` picks the tmux server, as `tmux -L`/`-S` would: the user's default one when empty.
export function createTmux(options: SpawnOptions = {}): Tmux {
  const connected = async <T>(work: (client: TmuxConnection) => Promise<T>): Promise<T> => {
    // The library's watcher, attached to whichever session tmux picks, since the commands name their target: it changes
    // nothing the user sees, the session's environment included. Without TMUX, which an app server started in tmux
    // inherits, `options` alone picks the server, and tmux does not refuse the attach while a launch's window is empty.
    const client = new TmuxClient(spawnTmux(watchServerArgs(), { ...options, env: { ...(options.env ?? process.env), TMUX: undefined } }));
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
    newWindow: ({ session, command, env }) =>
      connected(async (client) => {
        // tmux takes a session by id: a name it would also match as a prefix, a pattern, another session's id or a client.
        const named = (await listSessions(client)).find((found) => found.sessionName === session);
        if (named === undefined) throw new TmuxRefused(`no session named ${session}`);
        // The window opens empty and the command starts once its pane keeps a failed process, so a command that cannot
        // run leaves its pane, dead, showing why, where tmux would close the window. Any dead-pane message tmux prints
        // scrolls the screen, the shell's words with it, off into the pane's history: the pane prints none.
        const { windowId, paneId } = await newEmptyWindow(client, { sessionId: named.sessionId, select: true });
        try {
          await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
          await client.execute(`set-option -p -t %${paneId} remain-on-exit-format ''`);
          await respawnPane(client, paneId, { command, environment: env });
        } catch (error) {
          // A window whose command never started is the launch's to remove.
          await client.execute(`kill-window -t @${windowId}`).catch((removal: unknown) => {
            throw new AggregateError([error, removal], `${describe(error)}; its empty window @${windowId} stays: ${describe(removal)}`);
          });
          throw error;
        }
        return { window_id: `@${windowId}`, pane_id: `%${paneId}` };
      }),
  };
}

// [LAW:single-enforcer] The one place the library's errors become the seam's: a command tmux answered with an error, and
// a connection that ended first, whose reason is tmux's words when it gave some, in the bytes spawnTmux delivers them in.
function refused(error: unknown): unknown {
  if (error instanceof TmuxCommandError) return new TmuxRefused(error.message, { cause: error });
  if (error instanceof TransportClosedError) return new TmuxRefused(error.reason === undefined ? error.message : Buffer.from(error.reason, "latin1").toString("utf8"), { cause: error });
  return error;
}
