import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { eventLog } from "@cc-dump/log/testing";
import { WebSocketTmuxClient, type BrowserWebSocketLike } from "@promptctl/tmux-control-mode-js/websocket";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { tmuxPath } from "./address.ts";
import { sessionId, type TmuxWindow } from "./format.ts";
import { createTerminal } from "./terminal.ts";
import { terminal, tmuxServer } from "./testing.ts";

// A page's WebSocket as a browser opens it, with its page's origin, which only ws lets a test set. As the client's socket
// it is the browser's in all but its type: ws also has binary types a browser lacks, and the client sets its own.
const fromPage = (origin: string, url: string, protocols?: string | string[]) => new WebSocket(url, protocols, { headers: { origin } });
const pageSocket = (origin: string) => (url: string, protocols?: string | string[]) => fromPage(origin, url, protocols) as unknown as BrowserWebSocketLike;

// A page's client of `window`, closed when the test finishes.
function pageClient(port: number, window: TmuxWindow) {
  const client = new WebSocketTmuxClient({ url: `ws://127.0.0.1:${port}${tmuxPath(window)}`, createWebSocket: pageSocket("http://127.0.0.1:3346"), reconnect: { maxAttempts: 0 } });
  onTestFinished(() => client.close());
  return client;
}

// The status a refused WebSocket was answered with.
async function refusal(socket: WebSocket) {
  const [, response] = (await once(socket, "unexpected-response")) as [unknown, { statusCode: number }];
  return response.statusCode;
}

// The bridge's events, up to and including its connection's closing.
async function untilClosed(bridge: () => Promise<Record<string, unknown>>) {
  const seen = [];
  for (let event = await bridge(); ; event = await bridge()) {
    seen.push(event);
    if (event.kind === "connection-closed") return seen;
  }
}

describe("createTerminal", () => {
  it("connects a page to its window's session, whichever session tmux would pick, in its upgrade's trace", async () => {
    const { port, next, bridge, windowOf } = await terminal("first", "agent's");
    const window = windowOf("agent's");
    const client = pageClient(port, window);

    const { output } = await client.execute("display-message -p '#{session_name}'");
    expect(output).toEqual(["agent's"]);
    await client.close();

    const upgrade = await next();
    expect(upgrade).toMatchObject({ event: "upgrade", outcome: "ok", url: tmuxPath(window), protocol: "websocket" });
    const seen = await untilClosed(bridge);
    expect(seen[0]).toMatchObject({ event: "tmux_bridge", kind: "connection-opened", outcome: "ok" });
    expect(seen.map(({ trace_id }) => trace_id)).toEqual(seen.map(() => upgrade.trace_id));
  });

  it("records a call tmux refuses as that call's failure, and the connection, which goes on, as ok", async () => {
    const { port, next, bridge, windowOf } = await terminal("work");
    const client = pageClient(port, windowOf("work"));

    await expect(client.execute("select-window -t @999")).rejects.toThrow();
    expect(await client.execute("display-message -p ok")).toMatchObject({ output: ["ok"] });
    await client.close();

    expect(await next()).toMatchObject({ event: "upgrade", outcome: "ok" });
    expect(await untilClosed(bridge)).toContainEqual(expect.objectContaining({ kind: "result", outcome: "error" }));
  });

  it("closes a page of a window whose session ends, as tmux ends its client, and records the connection as ok", async () => {
    const { port, next, bridge, windowOf, tmux, clients } = await terminal("work", "agent's");
    const client = pageClient(port, windowOf("agent's"));
    await client.execute("display-message -p ok");
    tmux("kill-session", "-t", "=agent's");

    const seen = await untilClosed(bridge);
    expect(seen).toContainEqual(expect.objectContaining({ kind: "upstream-closed", reason: "exit", outcome: "ok" }));
    expect(seen.at(-1)).toMatchObject({ errorCode: "BRIDGE_CLOSED", outcome: "ok" });
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "ok" });
    expect(clients()).toEqual([]);
  });

  it.each([
    ["whose session has ended", (window: TmuxWindow) => ({ ...window, session_id: sessionId("$999") })],
    // Only the start time tells this server from the one the window was named on.
    ["of a tmux server since restarted, whose ids name other sessions now", (window: TmuxWindow) => ({ ...window, start_time: window.start_time - 1 })],
  ])("never welcomes a page of a window %s, so its reconnects run out, and attaches nothing", async (_, gone) => {
    const { port, next, bridge, windowOf, tmux } = await terminal("work");
    const window = windowOf("work");
    // A hook on the session another server's window would name: it fires if a client ever attaches there.
    tmux("set-hook", "-t", window.session_id, "client-attached", `set-option -t '${window.session_id}' @touched yes`);
    const client = new WebSocketTmuxClient({ url: `ws://127.0.0.1:${port}${tmuxPath(gone(window))}`, createWebSocket: pageSocket("http://127.0.0.1:3346"), reconnect: { maxAttempts: 2, initialDelayMs: 1, jitterMs: 0 } });
    onTestFinished(() => client.close());

    await vi.waitFor(() => expect(client.connectionState).toMatchObject({ status: "closed" }), { timeout: 5000 });
    const seen = await untilClosed(bridge);
    expect(seen.at(-1)).toMatchObject({ errorCode: "BRIDGE_INTERNAL", outcome: "error", reason: expect.stringMatching(/attaching to session \$\d+ of the tmux server started at \d+: transport closed before command completed$/) });
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error" });
    expect(tmux("show-options", "-v", "-q", "-t", window.session_id, "@touched")).toBe("");
  });

  it("gives each page a tmux client of its own, attached while the page is there", async () => {
    const { port, windowOf, clients } = await terminal("work");
    const window = windowOf("work");
    const first = pageClient(port, window);
    const second = pageClient(port, window);

    await Promise.all([first.execute("display-message -p ok"), second.execute("display-message -p ok")]);
    expect(clients()).toEqual(["work", "work"]);

    await first.close();
    await vi.waitFor(() => expect(clients()).toEqual(["work"]));
    await second.close();
    await vi.waitFor(() => expect(clients()).toEqual([]));
  });

  it("fails the upgrade of a page that breaks the bridge's protocol, with every event of its bridge in its trace", async () => {
    const { port, next, bridge, windowOf } = await terminal("work");
    const socket = fromPage("http://127.0.0.1:3346", `ws://127.0.0.1:${port}${tmuxPath(windowOf("work"))}`);
    await once(socket, "open");
    socket.send("not the bridge's protocol");
    await once(socket, "close");

    const upgrade = await next();
    expect(upgrade).toMatchObject({ event: "upgrade", outcome: "error" });
    const seen = await untilClosed(bridge);
    expect(seen).toContainEqual(expect.objectContaining({ kind: "protocol-error", outcome: "error" }));
    expect(seen.map(({ trace_id }) => trace_id)).toEqual(seen.map(() => upgrade.trace_id));
  });

  it("refuses a page from another site, which would type into the user's shell", async () => {
    const { port, next, windowOf } = await terminal("work");

    expect(await refusal(fromPage("https://example.com", `ws://127.0.0.1:${port}${tmuxPath(windowOf("work"))}`))).toBe(403);
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", error: expect.stringContaining("https://example.com cannot reach tmux") });
  });

  it.each([
    "/elsewhere",
    "/tmux",
    "/tmux/1/%240/%403/more",
    "/tmux/1/%403",
    "/tmux/x/%240/%403",
    "/tmux/01/%240/%403",
    "/tmux/9007199254740993/%240/%403",
    "/tmux/1/0/%403",
    "/tmux/1/%240/%4003",
    "/tmux/1/%40/%403",
    "/tmux/1/%E0/%403",
  ])("takes a WebSocket at a window's address alone, not %s", async (path) => {
    const { port, next } = await terminal("work");

    expect(await refusal(fromPage("http://localhost:3346", `ws://127.0.0.1:${port}${path}`))).toBe(404);
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", url: path });
  });

  it.each([
    ["a target that is no URL's", "//"],
    ["a handshake it cannot take", undefined],
  ])("answers %s, and closes it", async (_, target) => {
    const { port, next, windowOf } = await terminal("work");
    const socket = connect(port, "127.0.0.1");
    socket.end(`GET ${target ?? tmuxPath(windowOf("work"))} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);

    const answer: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => answer.push(chunk));
    await once(socket, "close");
    expect(Buffer.concat(answer).toString()).toMatch(target === undefined ? /^HTTP\/1\.1 400 Bad Request/ : /^HTTP\/1\.1 404 Not Found/);
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", error: expect.stringContaining(target === undefined ? "Sec-WebSocket" : "Nothing takes") });
  });

  it("is done with a handshake whose socket closed before ws could take it, which ws destroys without a word", async () => {
    const { socketPath, windowOf } = tmuxServer("work");
    const upgrade = createTerminal(eventLog().log, { socketPath });
    const socket = new Duplex({ read: () => {}, write: (_chunk, _encoding, done) => done() });
    socket.push(null);
    socket.resume();
    await once(socket, "end");
    const headers = { origin: "http://127.0.0.1:3346", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
    const req = { method: "GET", url: tmuxPath(windowOf("work")), headers } as IncomingMessage;
    const fail = vi.fn();

    await upgrade(req, socket, Buffer.alloc(0), { trace_id: "0".repeat(32), fail, ended: new Promise(() => {}) });
    expect(socket.destroyed).toBe(true);
    expect(fail).not.toHaveBeenCalled();
  });
});
