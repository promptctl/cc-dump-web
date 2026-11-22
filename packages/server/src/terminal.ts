import { admit, askedOf, refuseUpgrade, Refused } from "@cc-dump/log/answer";
import { failed, loggedAfter, type Facts, type Log, type Upgrade, type Work } from "@cc-dump/log";
import { describe } from "@cc-dump/log/describe";
import { Malformed } from "@cc-dump/log/failure";
import type { SpawnOptions } from "@promptctl/tmux-control-mode-js";
import type { BridgeObservabilityEvent } from "@promptctl/tmux-control-mode-js/websocket";
import { createWebSocketBridge } from "@promptctl/tmux-control-mode-js/websocket/server";
import { WebSocketServer } from "ws";
import { TMUX_PATH } from "./address.ts";
import { sessionId, startTime, windowId, type TmuxWindow } from "./format.ts";
import { attach } from "./tmux.ts";

// What a page's terminal reaches tmux through (docs/design/01-features.md, F13): a WebSocket at a window's address
// (tmuxPath), taken into a bridge of the library's of its own, whose tmux client is the page's own, attached to the
// window's session. `options` picks the tmux server, as createTmux's do.
// [LAW:no-ambient-temporal-coupling] The page's connection does no work of its own between its request and the
// handshake, so ws takes the socket the moment node hands it over, and the bridge, the owner of the page's tmux client,
// ends it whenever the page leaves. Everything about the connection, each bridge event included, closes over its unit of
// work. The connection is done when its refusal is answered, or when the bridge's handling of it ends, after the bridge
// has said how it ended, the closing of the page's tmux client included.
export function createTerminal(log: Log, options: SpawnOptions = {}): Upgrade {
  return (req, socket, head, work) => {
    let window: TmuxWindow;
    try {
      window = windowOf(admit(askedOf(req)).url);
    } catch (error) {
      return Promise.resolve(refuseUpgrade(socket, work, error));
    }
    const bridge = createWebSocketBridge({
      // The page's own tmux client: only closing a client takes back the size it declared, so a page sizes the window
      // while it is there, and two pages on one window size it as two terminals do.
      createClient: () => attach(options, window),
      disposeClient: (client) => client.close(),
      onEvent: bridgeEvent(log, work),
    });
    const sockets = new WebSocketServer({ noServer: true, clientTracking: false });
    return new Promise<void>((done) => {
      // A socket ws finds no longer open it destroys and says nothing of: until ws takes the socket, its close ends the
      // connection, and once ws has, the bridge's handling does, whatever the socket does after. The first call to
      // `done` decides: ws calls back as it takes the socket, in handleUpgrade itself, so the bridge's handling is the
      // promise's before any close of the socket it took, and that close's `done()` changes nothing.
      socket.once("close", () => done());
      // With a listener on wsClientError ws neither answers nor closes a handshake it cannot take (a malformed one), so
      // the refusal does both.
      sockets.on("wsClientError", (error) => done(refuseUpgrade(socket, work, new Refused(400, describe(error), { cause: error }))));
      sockets.handleUpgrade(req, socket, head, (ws) =>
        done(bridge.handleConnection(ws, { url: req.url!, headers: req.headers, remoteAddress: req.socket.remoteAddress! })),
      );
    });
  };
}

const windowPath = new RegExp(`^${TMUX_PATH}/([^/]+)/([^/]+)/([^/]+)$`);

// [LAW:parse-dont-validate] The window a WebSocket's request asks for, by its address, or a refusal: a path of the shape
// that names no window is refused as any path naming nothing is.
function windowOf({ pathname }: URL): TmuxWindow {
  const path = windowPath.exec(pathname);
  try {
    if (path !== null)
      return { start_time: startTime(path[1]!), session_id: sessionId(decodeURIComponent(path[2]!)), window_id: windowId(decodeURIComponent(path[3]!)) };
  } catch (error) {
    // An id that does not parse, or an escape that does not decode, names no window; any other error is a bug.
    if (!(error instanceof Malformed || error instanceof URIError)) throw error;
  }
  throw new Refused(404, `Nothing takes a WebSocket at ${pathname}`);
}

// [LAW:nothing-unseen] What the page's bridge reports, one event each, in the trace of the page's connection: its
// opening and closing, each call the page made of tmux (a keystroke's send-keys, a resize) with how long tmux took and
// whether it failed, and the bridge's own trouble. Each event the bridge forwards to the page is left out: it is tmux's
// own notification stream, as many as the panes' output. An event's failure is the connection's only when it says the
// connection failed; a call that fails or is denied is that call's, and the connection goes on.
function bridgeEvent(log: Log, work: Work) {
  return (event: BridgeObservabilityEvent) => {
    if (event.kind === "event-out") return;
    const { facts, duration_ms, fault } = verdict(event);
    if (fault.of === "connection") work.fail(fault.error);
    loggedAfter(log, work.trace_id, "tmux_bridge", facts, duration_ms, fault.of === "none" ? { outcome: "ok" } : failed(fault.error));
  };
}

// [LAW:types-are-the-program] What one of the bridge's events says: its facts, how long it took (only a call's result
// is timed), and its fault: none, or a failure with whose it is, one call's or the connection's. Each event decides
// only its own fact. The switch is exhaustive, so a kind the library adds is a type error here, never an event recorded
// as fine.
type Fault = { of: "none" } | { of: "call" | "connection"; error: Error };
type Verdict = { facts: Facts; duration_ms: number; fault: Fault };
const none: Fault = { of: "none" };
function verdict(event: Exclude<BridgeObservabilityEvent, { kind: "event-out" }>): Verdict {
  const said = (fault: Fault): Verdict => ({ facts: event, duration_ms: 0, fault });
  const ofConnection = (error: Error): Fault => ({ of: "connection", error });
  switch (event.kind) {
    case "result": {
      const { durationMs, ok, ...facts } = event;
      return { ...said(ok ? none : { of: "call", error: new Error(`call ${event.id} failed: ${event.code}`) }), facts, duration_ms: durationMs };
    }
    case "call":
      return said(event.allowed ? none : { of: "call", error: new Error(`call ${event.id} (${event.method}) denied: ${event.denyReason}`) });
    case "shutdown-requested":
    case "connection-opened":
      return said(none);
    // BRIDGE_CLOSED is the bridge closing a connection whose end came from elsewhere, the reason saying where: the
    // server's shutdown, a page gone silent, or the page's tmux client ending, normally or not, which upstream-closed
    // reports. Any other code names a fault of the connection's.
    case "connection-closed":
      return said(event.errorCode === undefined || event.errorCode === "BRIDGE_CLOSED" ? none : ofConnection(new Error(`${event.errorCode}: ${event.reason}`)));
    // A client tmux ends is an exit: the window's session gone while the page was there. One gone before is the attach's
    // failure, which the bridge closes the connection on as BRIDGE_INTERNAL.
    case "upstream-closed":
      return said(event.reason === "transport-error" ? ofConnection(new Error("the page's tmux client failed")) : none);
    case "protocol-error":
    case "client-dispose-failed":
    case "release-failed":
      return said(ofConnection(new Error(event.message)));
    case "pane-resume-failed":
    case "cross-session-layout-release-failed":
    case "handshake-failure-unreported":
      return said(ofConnection(new Error(`${event.code}: ${event.message}`)));
  }
}
