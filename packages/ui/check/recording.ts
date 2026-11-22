import { createReadStream } from "node:fs";
import { asError } from "@cc-dump/log/describe";
import { parseRecordedEvent, type RecordedEvent } from "@cc-dump/proxy/format";
import { recordedLength, splitLines } from "@cc-dump/proxy/recording";
import { refusedAt, type Connection } from "../src/connection/connection.ts";

// What a read of a recording's file comes to, in order: each event with the offset its line ends at, then the end, or
// the failure that stopped it.
type Item = { kind: "event"; event: RecordedEvent; offset: number } | { kind: "end"; unterminated: number } | { kind: "failed"; error: Error };

// [LAW:no-silent-failure] A line that does not parse stops the read where it ends (connection.ts, refusedAt), and a
// recording that is not there fails it, since a recording with no file is none, not an empty one.
const parsed = (line: Buffer, offset: number): RecordedEvent => {
  try {
    return parseRecordedEvent(line.toString("utf8"));
  } catch (error) {
    throw refusedAt(offset, error);
  }
};

// A recording's file read an event at a time, as every reader of one reads it (proxy/src/recording.ts, `splitLines`
// and `recordedLength`), so a check of a recording larger than memory holds only what it keeps. `unterminated`: the
// bytes after the recording's last newline, which a write cut short left and which are no event. Every way the read
// can fail is an item, so what the generator's consumer throws is the consumer's own.
async function* itemsOf(recording: string): AsyncGenerator<Item> {
  try {
    const measure = recordedLength(recording);
    if (measure === undefined) throw new Error(`no recording at ${recording}`);
    const { terminated, unterminated } = measure;
    let offset = 0;
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of terminated === 0 ? [] : createReadStream(recording, { end: terminated - 1 })) {
      const data = Buffer.concat([pending, chunk]);
      const { lines, rest } = splitLines(data, offset);
      for (const { line, end } of lines) yield { kind: "event", event: parsed(line, end), offset: end };
      offset += data.length - rest.length;
      pending = rest;
    }
    yield { kind: "end", unterminated };
  } catch (error) {
    yield { kind: "failed", error: asError(error) };
  }
}

// [LAW:locality-or-seam] A connection that reads recordings from their files, as the server reads one the proxy is not
// writing (connection.ts, Reader): each event with the offset its line ends at, then its end, with the bytes after its
// last newline, or the failure that stopped it; nothing once `signal` aborts. So a check reads a recording the one way
// the tab does (reading.ts). A reader that throws is its own failure, and not the read's: it is not reported to it.
export const fileConnection: Pick<Connection, "read"> = {
  read: (recording, reader, signal) => {
    signal.throwIfAborted();
    void (async () => {
      for await (const item of itemsOf(recording)) {
        if (signal.aborted) return;
        switch (item.kind) {
          case "event":
            reader.event(item.event, item.offset);
            break;
          case "end":
            reader.end({ unterminated_bytes: item.unterminated });
            break;
          case "failed":
            reader.failed(item.error);
        }
      }
    })();
  },
};
