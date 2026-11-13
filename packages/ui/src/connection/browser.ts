import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListings, parseRecordedEvent, parseRecordingEnd } from "@cc-dump/proxy/format";
import type { Connection } from "./connection.ts";

// The browser talking to the proxy's reader, on the host the page was served from: `fetch` for the list,
// and one EventSource per read, which resumes a dropped connection from `Last-Event-ID` by itself.
export function createBrowserConnection(origin = `http://${location.hostname}:${READER_PORT}`): Connection {
  return {
    recordings: async (signal) => {
      const res = await fetch(`${origin}/recordings`, { signal });
      if (!res.ok) throw new Error(`GET /recordings: ${res.status} ${res.statusText}`);
      return parseListings(await res.text());
    },
    read: (name, reader, signal) => {
      signal.throwIfAborted();
      const url = `${origin}/recordings/${encodeURIComponent(name)}`;
      const source = new EventSource(url);
      // [LAW:no-ambient-temporal-coupling] The read's lifetime, which closing it ends: the EventSource closes and
      // every listener of the read is removed, so nothing is delivered after it has ended. Closing alone would not
      // do: node's EventSource goes on dispatching the rest of a chunk it has already received.
      const open = new AbortController();
      const listening = { signal: open.signal };
      const close = () => open.abort();
      open.signal.addEventListener("abort", () => source.close());
      signal.addEventListener("abort", close, listening);
      // A message that does not parse ends the read: what follows it cannot be trusted to be the recording.
      const receive =
        <T>(parse: (data: string) => T, deliver: (value: T) => void) =>
        ({ data }: MessageEvent<string>) => {
          let value: T;
          try {
            value = parse(data);
          } catch (error) {
            close();
            return reader.failed(new Error(`GET ${url}`, { cause: error }));
          }
          deliver(value);
        };
      source.addEventListener("message", receive(parseRecordedEvent, reader.event), listening);
      // A finished recording's last message. Closed here, or the EventSource reconnects and reads it again.
      source.addEventListener(
        "end",
        receive(parseRecordingEnd, (end) => {
          close();
          reader.end(end);
        }),
        listening,
      );
      // An error that leaves the EventSource CONNECTING is the browser reconnecting after a dropped connection.
      // One that leaves it CLOSED is a read the reader did not serve (a name not listed, a position that is no
      // event's, a server error), and the EventSource does not say which: the reader's request event in the proxy's
      // log does.
      source.addEventListener(
        "error",
        () => {
          if (source.readyState !== EventSource.CLOSED) return;
          close();
          reader.failed(new Error(`GET ${url}: not served; its status is on the reader's request event in the proxy's log`));
        },
        listening,
      );
    },
  };
}
