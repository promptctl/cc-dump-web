import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListings, parseProxyStatus, parseReadFailure, parseRecordedEvent, parseRecordingEnd } from "@cc-dump/proxy/format";
import type { Connection } from "./connection.ts";

// The browser talking to the proxy's reader, on the host the page was served from: `fetch` for the list, and one
// EventSource per read and per status, which resumes a dropped connection by itself.
export function createBrowserConnection(origin = `http://${location.hostname}:${READER_PORT}`): Connection {
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
      const stream = eventStream(`${origin}/recordings/${encodeURIComponent(name)}`, signal, reader.failed);
      stream.on("message", parseRecordedEvent, reader.event);
      // A finished recording's end is the read's last message: closed on it, or the EventSource reconnects and reads
      // the recording again.
      stream.on("end", parseRecordingEnd, (end) => {
        stream.close();
        reader.end(end);
      });
    },
    status: (watcher, signal) => eventStream(`${origin}/status`, signal, watcher.failed).on("message", parseProxyStatus, watcher.status),
  };
}

// One EventSource at `url`, from its opening to its end, which is `close`, or `signal` aborting, or a failure reported
// to `failed`: a message that does not parse (what follows it cannot be trusted), the reader's `failed` event, or the
// request not being served. `on` delivers each message of a type, parsed.
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
  const on = <T>(type: string, parse: (data: string) => T, deliver: (value: T) => void) =>
    source.addEventListener(
      type,
      ({ data }: MessageEvent<string>) => {
        let value: T;
        try {
          value = parse(data);
        } catch (error) {
          return fail(new Error(`GET ${url}`, { cause: error }));
        }
        deliver(value);
      },
      listening,
    );
  on("failed", parseReadFailure, ({ message }) => fail(new Error(`GET ${url}`, { cause: new Error(`the reader failed: ${message}`) })));
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
  return { on, close };
}
