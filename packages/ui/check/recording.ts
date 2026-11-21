import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { asError } from "@cc-dump/log/describe";
import { parseRecordedEvent, type RecordedEvent } from "@cc-dump/proxy/format";
import { recordedLength } from "@cc-dump/proxy/recording";
import { refusedAt, type Connection } from "../src/connection/connection.ts";
import { add, type ByTrace, type Exchange } from "../src/exchanges.ts";

// A recording's events, parsed an event at a time, so a check of a recording larger than memory holds only what it
// keeps: each with the offset its line ends at. `unterminated`: the bytes after the recording's last newline, which a
// write cut short left and which are no event, measured as every reader measures them. [LAW:no-silent-failure] A line
// that does not parse stops the read where it ends (connection.ts, refusedAt), and a recording that is not there fails
// the read, since `recordedLength` measures one as empty, which is right for the writer that starts it and wrong here.
function eventsOf(recording: string): { unterminated: number; events: AsyncGenerator<{ event: RecordedEvent; offset: number }> } {
  const { terminated, unterminated } = recordedLength(recording);
  async function* events() {
    await stat(recording);
    if (terminated === 0) return;
    let offset = 0;
    for await (const line of createInterface({ input: createReadStream(recording, { end: terminated - 1 }), crlfDelay: Infinity })) {
      offset += Buffer.byteLength(line) + 1;
      try {
        yield { event: parseRecordedEvent(line), offset };
      } catch (error) {
        throw refusedAt(offset, error);
      }
    }
  }
  return { unterminated, events: events() };
}

// A recording's events folded as a read folds them (exchanges.ts, add), each placed in its exchange in `byTrace`, with
// that exchange. An event the fold refuses stops the read where its line ends.
export function foldOf(recording: string, byTrace: ByTrace): { unterminated: number; events: AsyncGenerator<{ event: RecordedEvent; exchange: Exchange }> } {
  const { unterminated, events } = eventsOf(recording);
  async function* folded() {
    for await (const { event, offset } of events) {
      const exchange = add(byTrace, event);
      if (typeof exchange === "string") throw refusedAt(offset, exchange);
      yield { event, exchange };
    }
  }
  return { unterminated, events: folded() };
}

// [LAW:locality-or-seam] A connection that reads recordings from their files, as the server reads one the proxy is not
// writing (connection.ts, Reader): each event with the offset its line ends at, then its end, with the bytes after its
// last newline, or the failure that stopped it; nothing once `signal` aborts. So a check reads a recording the one way
// the tab does (reading.ts).
export const fileConnection: Pick<Connection, "read"> = {
  read: (recording, reader, signal) => {
    signal.throwIfAborted();
    const { unterminated, events } = eventsOf(recording);
    // Delivers unless the read was aborted, and says whether it did.
    const delivered = (deliver: () => void) => {
      if (signal.aborted) return false;
      deliver();
      return true;
    };
    void (async () => {
      try {
        for await (const { event, offset } of events) if (!delivered(() => reader.event(event, offset))) return;
        delivered(() => reader.end({ unterminated_bytes: unterminated }));
      } catch (error) {
        delivered(() => reader.failed(asError(error)));
      }
    })();
  },
};
