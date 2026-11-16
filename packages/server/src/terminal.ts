import type { Duplex } from "node:stream";
import { loggedAfter, type Facts, type Log, type Upgrade, type Work } from "@cc-dump/log";
import type { SpawnOptions } from "@promptctl/tmux-control-mode-js";
import type { BridgeObservabilityEvent } from "@promptctl/tmux-control-mode-js/websocket";
import { createWebSocketBridge } from "@promptctl/tmux-control-mode-js/websocket/server";
import { WebSocketServer } from "ws";
import { TMUX_PATH } from "./address.ts";
import { sessionId, startTime, windowId, type TmuxWindow } from "./format.ts";
import { fromThisMachine } from "./origin.ts";
import { attach } from "./tmux.ts";

// What a page's terminal reaches tmux through (docs/design/01-mvp.md, F13): a WebSocket at a window's address
// (tmuxPath), taken into a bridge of the library's of its own, whose tmux client is the page's own, attached to the
// window's session. `options` picks the tmux server, as createTmux's do.
// [LAW:no-ambient-temporal-coupling] The page's connection does no work of its own between its request and the
// handshake, so ws takes the socket the moment node hands it over, and the bridge, the owner of the page's tmux client,
// ends it whenever the page leaves. Everything about the connection, each bridge event included, closes over its unit of
// work. The connection is done when its refusal is answered, or when the bridge's handling of it ends, after the bridge
// has said how it ended, the closing of the page's tmux client included.
export function createTerminal(log: Log, options: SpawnOptions = {}): Upgrade {
  return (req, socket, head, work) => {
    const asked = askedFor(req.url!, req.headers.origin);
    if ("refused" in asked) return Promise.resolve(refuse(socket, work, asked.refused, asked.why));
    const bridge = createWebSocketBridge({
      // The page's own tmux client: only closing a client takes back the size it declared, so a page sizes the window
      // while it is there, and two pages on one window size it as two terminals do.
      createClient: () => attach(options, asked.window),
      disposeClient: (client) => client.close(),
      onEvent: bridgeEvent(log, work),
    });
    const sockets = new WebSocketServer({ noServer: true, clientTracking: false });
    return new Promise<void>((done) => {
      // A socket ws finds no longer open it destroys and says nothing of: until ws takes the socket, its close ends the
      // connection, and once ws has, the bridge's handling does, whatever the socket does after.
      socket.once("close", () => done());
      // With a listener on wsClientError ws neither answers nor closes a handshake it cannot take (a malformed one), so
      // the refusal does both.
      sockets.on("wsClientError", (error) => done(refuse(socket, work, "400 Bad Request", error)));
      sockets.handleUpgrade(req, socket, head, (ws) =>
        done(bridge.handleConnection(ws, { url: req.url!, headers: req.headers, remoteAddress: req.socket.remoteAddress! })),
      );
    });
  };
}

// A handshake refused: the status it is answered with, and why, which fails its unit of work.
type Refusal = { refused: string; why: unknown };

// [LAW:single-enforcer] The one way an upgrade is refused: answered with `status`, then closed once the answer is
// written, as ws closes one it refuses itself, and its unit of work failed with `why`. A socket already closed takes
// no answer, and the upgrade is failed all the same.
function refuse(socket: Duplex, work: Work, status: string, why: unknown) {
  work.fail(why);
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const windowPath = new RegExp(`^${TMUX_PATH}/([^/]+)/([^/]+)/([^/]+)$`);

// [LAW:parse-dont-validate] What a WebSocket's request asks for: a window, by its address, from a page on this machine,
// or a refusal saying why. A target that does not parse as a URL's, or a path of the shape that names no window, is
// refused as any path naming nothing is.
function askedFor(url: string, origin: string | undefined): { window: TmuxWindow } | Refusal {
  if (!fromThisMachine(origin)) return { refused: "403 Forbidden", why: new Error(`A page at ${origin} cannot reach tmux`) };
  const path = windowPath.exec(URL.parse(url, "http://server")?.pathname ?? "");
  try {
    if (path !== null)
      return { window: { start_time: startTime(path[1]!), session_id: sessionId(decodeURIComponent(path[2]!)), window_id: windowId(decodeURIComponent(path[3]!)) } };
  } catch {
    // An id that does not parse, or an escape that does not decode, names no window.
  }
  return { refused: "404 Not Found", why: new Error(`Nothing takes a WebSocket at ${url}`) };
}

// [LAW:nothing-unseen] What the page's bridge reports, one event each, in the trace of the page's connection: its
// opening and closing, each call the page made of tmux (a keystroke's send-keys, a resize) with how long tmux took and
// whether it failed, and the bridge's own trouble. Each event the bridge forwards to the page is left out: it is tmux's
// own notification stream, as many as the panes' output. An event's failure is the connection's only when it says the
// connection failed; a call that fails or is denied is that call's, and the connection goes on.
function bridgeEvent(log: Log, work: Work) {
  return (event: BridgeObservabilityEvent) => {
    if (event.kind === "event-out") return;
    const { facts, duration_ms, failure } = verdict(event);
    if (failure?.of === "connection") work.fail(failure.error);
    loggedAfter(log, work.trace_id, "tmux_bridge", facts, duration_ms, failure?.error);
  };
}

// [LAW:types-are-the-program] What one of the bridge's events says: its facts, how long it took (only a call's result
// is timed), and the failure it reports, if any, with whose it is: one call's, or the connection's. Each event decides
// only its own fact. The switch is exhaustive, so a kind the library adds is a type error here, never an event recorded
// as fine.
type Verdict = { facts: Facts; duration_ms: number; failure: { error: Error; of: "call" | "connection" } | undefined };
function verdict(event: Exclude<BridgeObservabilityEvent, { kind: "event-out" }>): Verdict {
  const said = (error: Error | undefined, of: "call" | "connection" = "connection"): Verdict => ({
    facts: event,
    duration_ms: 0,
    failure: error === undefined ? undefined : { error, of },
  });
  switch (event.kind) {
    case "result": {
      const { durationMs, ok, ...facts } = event;
      return { ...said(ok ? undefined : new Error(`call ${event.id} failed: ${event.code}`), "call"), facts, duration_ms: durationMs };
    }
    case "call":
      return said(event.allowed ? undefined : new Error(`call ${event.id} (${event.method}) denied: ${event.denyReason}`), "call");
    case "shutdown-requested":
    case "connection-opened":
      return said(undefined);
    // BRIDGE_CLOSED is the bridge closing a connection whose end came from elsewhere, the reason saying where: the
    // server's shutdown, a page gone silent, or the page's tmux client ending, normally or not, which upstream-closed
    // reports. Any other code names a fault of the connection's.
    case "connection-closed":
      return said(event.errorCode === undefined || event.errorCode === "BRIDGE_CLOSED" ? undefined : new Error(`${event.errorCode}: ${event.reason}`));
    // A client tmux ends is an exit: the window's session gone while the page was there. One gone before is the attach's
    // failure, which the bridge closes the connection on as BRIDGE_INTERNAL.
    case "upstream-closed":
      return said(event.reason === "transport-error" ? new Error("the page's tmux client failed") : undefined);
    case "protocol-error":
    case "client-dispose-failed":
    case "release-failed":
      return said(new Error(event.message));
    case "pane-resume-failed":
    case "cross-session-layout-release-failed":
    case "handshake-failure-unreported":
      return said(new Error(`${event.code}: ${event.message}`));
  }
}
