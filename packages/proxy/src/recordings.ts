import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describeError, startSpan, type Ending, type Log } from "@cc-dump/log";
import { recordingStart } from "./format.ts";
import { createWriter, eventLine, recordedLength, type Recorder, type Writer } from "./recording.ts";

// The recordings of the proxy's run: where they are, `run`, the name of the one that takes the traffic no agent
// claims, how to record an exchange into one, and what a reader may ask of them. A reader never creates a writer, a
// file or a listing entry: only `record` does.
// - `readable(name)`: the bytes of the recording a reader may read, the writer's `written` while the run has one,
//   else `recordedLength` of what is on disk.
// - `follows(name)`: whether a read that reaches the end of the recording waits for more. An agent's recording is
//   followed, since its process may still be running, across restarts of the proxy and before its first request; so
//   is the run's own. Any other is finished.
// - `onWritten(listener)`: called with the name of each recording after an event is written to it, until the function
//   it returned is called.
export type Recordings = {
  dir: string;
  run: string;
  record: Recorder;
  readable: (name: string) => number;
  follows: (name: string) => boolean;
  onWritten: (listener: (name: string) => void) => () => void;
};

// [LAW:no-shared-mutable-globals] The writers are this function's alone, one per recording, added by `record` at the
// first event written to it.
// [LAW:nothing-unseen] An exchange's recording is its own unit of work, in the exchange's trace: its event, written
// with `end`, counts what was written and what failed, and names the first failure. A write that fails is counted and
// never stops or alters the agent's traffic. Writes are synchronous, so a disk that stalls stalls forwarding with it:
// that is the price of the guarantee that a proxy killed at any moment leaves every event it saw.
export function createRecordings(log: Log, dir: string, run: string): Recordings {
  mkdirSync(dir, { recursive: true });
  const writers = new Map<string, Writer>();
  const listeners = new Set<(name: string) => void>();
  const writerOf = (name: string) => {
    const writer = writers.get(name) ?? createWriter(join(dir, name));
    writers.set(name, writer);
    return writer;
  };
  const record: Recorder = (name, trace_id) => {
    const path = join(dir, name);
    const span = startSpan(trace_id);
    const counts = { events_written: 0, bytes_written: 0, events_failed: 0 };
    let failure: string | undefined;
    return (seen) => {
      const line = eventLine(trace_id, seen);
      try {
        writerOf(name).append(line);
        counts.events_written++;
        counts.bytes_written += line.length;
        for (const listener of listeners) listener(name);
      } catch (error) {
        counts.events_failed++;
        failure ??= describeError(error);
      }
      if (seen.type !== "end") return;
      const ending: Ending = failure === undefined ? { outcome: "ok" } : { outcome: "error", error: failure };
      log({ event: "record", ...span.end(), ...ending, path, counts });
    };
  };
  return {
    dir,
    run,
    record,
    readable: (name) => writers.get(name)?.written() ?? recordedLength(join(dir, name)).terminated,
    follows: (name) => name === run || recordingStart(name) !== undefined,
    onWritten: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
