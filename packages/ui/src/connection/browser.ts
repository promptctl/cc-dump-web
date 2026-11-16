import { LOOPBACK } from "@cc-dump/log/address";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListings, parseProxyStatus, parseReadFailure, parseRecordedEvent, parseRecordingEnd, type ReadFailure } from "@cc-dump/proxy/format";
import { SERVER_PORT, tmuxPath } from "@cc-dump/server/address";
import { parseFailure, parseLaunched, parseLauncher } from "@cc-dump/server/format";
import { WebSocketTmuxClient } from "@promptctl/tmux-control-mode-js/websocket";
import type { Connection } from "./connection.ts";

// The browser talking to the proxy's reader and the app server, on the address they are bound to, whatever host the
// page was opened at: `fetch` for the list and for launching, one EventSource per read and per status, which
// resumes a dropped connection by itself, and a WebSocket per terminal, through the app server.
export function createBrowserConnection({ readerPort = READER_PORT, serverPort = SERVER_PORT } = {}): Connection {
  const origin = `http://${LOOPBACK}:${readerPort}`;
  const server = `http://${LOOPBACK}:${serverPort}`;
  return {
    recordings: async (signal) => {
      const url = `${origin}/recordings`;
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return parseListings(await res.text());
      } catch (error) {
        throw new Error(`GET ${url}`, { cause: error });
      }
    },
    read: (name, reader, signal) => {
      const url = `${origin}/recordings/${encodeURIComponent(name)}`;
      const stream = eventStream(url, signal, reader.failed);
      // A message that does not parse ends the read: what follows it cannot be trusted to be the recording.
      stream.on("message", parseRecordedEvent, reader.event, stream.fail);
      // A read's last message, a finished recording's end or the reader's failure: closed on it, or the EventSource
      // reconnects and reads the recording again, or into the same failure.
      stream.on(
        "end",
        parseRecordingEnd,
        (end) => {
          stream.close();
          reader.end(end);
        },
        stream.fail,
      );
      const failed = ({ message }: ReadFailure) => stream.fail(new Error(`GET ${url}`, { cause: new Error(`the reader failed: ${message}`) }));
      stream.on("failed", parseReadFailure, failed, stream.fail);
    },
    // Each status is the whole of the proxy's state, so one that does not parse taints none after it: it is reported,
    // and the stream goes on. A UI reloaded into a status format its proxy has yet to restart into reads the restarted
    // proxy's status once it reconnects.
    status: (watcher, signal) => eventStream(`${origin}/status`, signal, watcher.failed).on("message", parseProxyStatus, watcher.status, watcher.failed),
    launcher: (signal) => answer(`${server}/launch`, { signal }, parseLauncher),
    launch: (launch, signal) =>
      answer(`${server}/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(launch), signal }, parseLaunched),
    // Ten reconnects, about a minute at the library's backoff, outlast the app server's restart on a change to its
    // source; a window that is gone is then no longer retried.
    tmux: (window) => new WebSocketTmuxClient({ url: `ws://${LOOPBACK}:${serverPort}${tmuxPath(window)}`, autoConnect: false, reconnect: { maxAttempts: 10 } }),
  };
}

// The app server's answer to one request, parsed. A refusal it answers fails in its own words, which are the user's to
// read as they are; anything else fails naming the request.
async function answer<T>(url: string, init: RequestInit, parse: (json: string) => T): Promise<T> {
  let refusal: string;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    if (res.ok) return parse(text);
    refusal = parseFailure(text).error;
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${url}`, { cause: error });
  }
  throw new Error(refusal);
}

// One EventSource at `url`, from its opening to its end, which is `close`, or `signal` aborting, or a failure reported
// to `failed`: the request not being served, or one its user reports with `fail`. `on` delivers each message of a
// type, parsed, and reports one that does not parse to `refused`.
function eventStream(url: string, signal: AbortSignal, failed: (error: Error) => void) {
  signal.throwIfAborted();
  const source = new EventSource(url);
  // [LAW:no-ambient-temporal-coupling] The stream's lifetime, which closing it ends: the EventSource closes and every
  // listener of the stream is removed, so nothing is delivered after it has ended. Closing alone would not do: node's
  // EventSource goes on dispatching the rest of a chunk it has already received.
  const open = new AbortController();
  const listening = { signal: open.signal };
  const close = () => open.abort();
  open.signal.addEventListener("abort", () => source.close());
  signal.addEventListener("abort", close, listening);
  // Closed on a failure, or the EventSource reconnects into the same one.
  const fail = (error: Error) => {
    close();
    failed(error);
  };
  const on = <T>(type: string, parse: (data: string) => T, deliver: (value: T) => void, refused: (error: Error) => void) =>
    source.addEventListener(
      type,
      ({ data }: MessageEvent<string>) => {
        let value: T;
        try {
          value = parse(data);
        } catch (error) {
          return refused(new Error(`GET ${url}`, { cause: error }));
        }
        deliver(value);
      },
      listening,
    );
  // An error that leaves the EventSource CONNECTING is the browser reconnecting after a dropped connection. One that
  // leaves it CLOSED is a request the reader did not serve (a name not listed, a position that is no event's, a server
  // error), and the EventSource does not say which: the reader's request event in the proxy's log does.
  source.addEventListener(
    "error",
    () => {
      if (source.readyState !== EventSource.CLOSED) return;
      fail(new Error(`GET ${url}: not served; its status is on the reader's request event in the proxy's log`));
    },
    listening,
  );
  return { on, close, fail };
}
