import "@xterm/xterm/css/xterm.css";
import { describe } from "@cc-dump/log/describe";
import type { TmuxWindow } from "@cc-dump/server/format";
import type { WindowTerminalError, WindowTerminalState } from "@promptctl/tmux-control-mode-js/window-terminal";
import { WindowTerminal } from "@promptctl/tmux-control-mode-js/window-terminal/react";
import { useLayoutEffect, useMemo, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { terminalTheme } from "../theme/terminal.ts";
import type { Theme } from "../theme/theme.ts";
import { view } from "./state.ts";

// The agent's tmux window, live, beside the conversation (docs/design/01-mvp.md, F13): every pane as tmux lays it out,
// what the agent prints as it prints it, and what the person types, once they click into a pane, sent to that pane. Its
// box sets the window's size, as an attached terminal's would. A reload mounts it again from tmux, so it is shown as it
// is now. Above it, chrome on the surface: which window it is, where its connection stands, the last thing that failed
// since the connection was last live, and the control that puts it away. One is mounted per window: another window is
// another terminal, with a connection of its own.
export function Terminal({ connection, window, theme }: { connection: Pick<Connection, "tmux">; window: TmuxWindow; theme: Theme }) {
  // [LAW:no-ambient-temporal-coupling] The terminal owns its connection: made once, as it mounts, connected while it is
  // mounted and closed as it unmounts. Closing ends the connection at once, so a remount connects it again. A window
  // terminal that starts on a closed connection is gone for good, so it is connected in a layout effect: React runs
  // every layout effect of a commit, a StrictMode remount's too, before the window terminal's own effect starts it.
  const [tmux] = useState(() => connection.tmux(window));
  useLayoutEffect(() => {
    void tmux.connect();
    return () => void tmux.close();
  }, [tmux]);
  const [state, setState] = useState<WindowTerminalState>({ phase: "connecting" });
  const [error, setError] = useState<WindowTerminalError | undefined>(undefined);
  // [LAW:one-source-of-truth] The UI's monospace face is the stylesheet's (index.css), read where xterm.js needs a name.
  const appearance = useMemo(
    () => ({ theme: terminalTheme(theme), fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono") }),
    [theme],
  );
  // A window terminal gone is gone for good, so its connection is closed then, and no longer attaches to the window's
  // session and sizes it.
  const changed = (next: WindowTerminalState) => {
    setState(next);
    if (next.phase === "live") setError(undefined);
    if (next.phase === "gone") void tmux.close();
  };
  return (
    <section aria-label="Terminal" className="flex min-h-0 min-w-0 flex-1 flex-col border-l">
      <header className="flex h-8 shrink-0 items-center gap-3 border-b bg-surface px-3 text-xs">
        <h2 className="font-semibold">Window {window.window_id}</h2>
        <p data-terminal-phase={state.phase} className={state.phase === "live" ? "text-foreground-muted" : "font-medium"}>
          {phaseText(state)}
        </p>
        <p className="min-w-0 flex-1 truncate text-error" title={error && describe(error.cause)}>
          {error && `${error.seam} failed: ${describe(error.cause)}`}
        </p>
        <button type="button" data-terminal-put-away onClick={view.putAway} className="control">
          Put away
        </button>
      </header>
      <WindowTerminal className="min-h-0 flex-1 bg-background" connection={tmux} window={window.window_id} appearance={appearance} onState={changed} onError={setError} />
    </section>
  );
}

// Where the terminal's connection to its window stands, in words.
function phaseText(state: WindowTerminalState): string {
  switch (state.phase) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Live";
    case "stale":
      return `Reconnecting: ${state.reason}`;
    case "gone":
      return state.reason === "window-closed" ? "The window closed" : `Gone: ${state.reason}${state.detail === undefined ? "" : `, ${state.detail}`}`;
  }
}
