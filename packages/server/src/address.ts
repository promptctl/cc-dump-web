import type { TmuxWindow } from "./format.ts";

// [LAW:one-source-of-truth] The app server's port. Its own module, so other parts can import it
// without starting the server.
export const SERVER_PORT = 3345;

// [LAW:one-source-of-truth] Where on the app server a page's WebSocket reaches a tmux window (docs/design/features.md,
// F13): under TMUX_PATH, by its whole address, its server's start time, its session's id and its own.
export const TMUX_PATH = "/tmux";
export const tmuxPath = ({ start_time, session_id, window_id }: TmuxWindow) =>
  `${TMUX_PATH}/${start_time}/${encodeURIComponent(session_id)}/${encodeURIComponent(window_id)}`;
