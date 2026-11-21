import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseRecordedEvent, type RecordedEvent } from "@cc-dump/proxy/format";
import { recordedLength } from "@cc-dump/proxy/recording";
import { refusedAt } from "../src/connection/connection.ts";
import { add, type ByTrace, type Exchange } from "../src/exchanges.ts";

// A recording's events folded as a read folds them (exchanges.ts, add), an event at a time, so a check of a recording
// larger than memory holds only what it keeps: each event, parsed and placed in its exchange in `byTrace`, with that
// exchange. `unterminated`: the bytes after the recording's last newline, which a write cut short left and which are no
// event, measured as every reader measures them. [LAW:no-silent-failure] An event that does not parse, or that the fold
// refuses, stops the read where its line ends (connection.ts, refusedAt).
export function foldOf(recording: string, byTrace: ByTrace): { unterminated: number; events: AsyncGenerator<{ event: RecordedEvent; exchange: Exchange }> } {
  const { terminated, unterminated } = recordedLength(recording);
  async function* events() {
    if (terminated === 0) return;
    let offset = 0;
    for await (const line of createInterface({ input: createReadStream(recording, { end: terminated - 1 }), crlfDelay: Infinity })) {
      offset += Buffer.byteLength(line) + 1;
      let event: RecordedEvent;
      try {
        event = parseRecordedEvent(line);
      } catch (error) {
        throw refusedAt(offset, error);
      }
      const exchange = add(byTrace, event);
      if (typeof exchange === "string") throw refusedAt(offset, exchange);
      yield { event, exchange };
    }
  }
  return { unterminated, events: events() };
}
