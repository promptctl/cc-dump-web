import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { startSpan, unitOfWork, type Log } from "@cc-dump/log";
import { recordingName } from "./format.ts";
import { createWriter, eventLine, recordedLength, type Recorder, type Writer } from "./recording.ts";

declare const listedOrFollowed: unique symbol;
// [LAW:types-are-the-program] A name `named` let through, the only name a read joins to the recordings directory.
export type ReadableName = string & { readonly [listedOrFollowed]: true };

// The recordings of the proxy's run: where they are, `run`, the name of the one that takes the traffic no agent
// claims, how to record an exchange into one, how to make one for a new agent, and what a reader may ask
// of them. A reader never creates a writer, a file or a listing entry: only `record` and `create` do.
// - `create()`: a new agent's recording, named for this moment, its file made empty and its writer this run's; the name.
// - `readable(name)`: the bytes of a recording this run writes that a reader may read, its writer's `written`. A
//   recording no writer of this run holds is finished, and its reader measures it once (`measure`).
// - `follows(name)`: whether a read that reaches the end of the recording waits for more: exactly when this run holds
//   a writer for it, which is the run's own recording from its first event, a recording `create` made, and an agent's
//   that a request continued after a restart of the proxy. Any other is finished, as far as this run knows.
// - `onWritten(listener)`: called with the name of each recording after an event is written to it, until the function
//   it returned is called.
// - `listed()`: the names of the recordings that hold something, in no order of its own: a recording with no bytes has
//   no conversation, and one a launch made is opened by its name. One that went between the listing and the look at
//   its size is not listed.
// - `named(asked)`: the name a reader may read, or none: a file the directory lists, spelled as it lists it, or a
//   recording this run follows, by the name it was given.
// - `measure(name)`: the recording's file's `recordedLength`, none where there is no file.
// - `read(name, position, length)`: up to `length` bytes of the recording's file from `position`; fewer where the file
//   ends first. The file is opened for the read and closed once it settles.
export type Recordings = {
  dir: string;
  run: string;
  record: Recorder;
  create: () => string;
  readable: (name: string) => number;
  follows: (name: string) => boolean;
  onWritten: (listener: (name: string) => void) => () => void;
  listed: () => Promise<string[]>;
  named: (asked: string) => Promise<ReadableName | undefined>;
  measure: (name: ReadableName) => ReturnType<typeof recordedLength>;
  read: (name: ReadableName, position: number, length: number) => Promise<Buffer>;
};

// [LAW:no-shared-mutable-globals] The writers are this function's alone, one per recording, added by `create` and by
// `record` at the first event written to a recording it did not create. `now` is the clock `create` names a recording
// from.
// [LAW:nothing-unseen] An exchange's recording is its own unit of work, in the exchange's trace: its event, written
// with `end`, counts what was written and what failed, and names the first failure. A write that fails is counted and
// never stops or alters the agent's traffic. Writes are synchronous, so a disk that stalls stalls forwarding with it:
// that is the price of the guarantee that a proxy killed at any moment leaves every event it saw.
export function createRecordings(log: Log, dir: string, run: string, now: () => Date = () => new Date()): Recordings {
  mkdirSync(dir, { recursive: true });
  const writers = new Map<string, Writer>();
  const listeners = new Set<(name: string) => void>();
  const writerOf = (name: string) => {
    const writer = writers.get(name) ?? createWriter(join(dir, name));
    writers.set(name, writer);
    return writer;
  };
  // [LAW:single-enforcer] The one way a new agent's recording gets its name: the file is made with O_EXCL, so two
  // made in one millisecond, or one at the moment of a recording already there, never share a recording; the next
  // millisecond is the next name.
  const create = () => {
    for (let at = now().getTime(); ; at++) {
      const name = recordingName(new Date(at));
      try {
        closeSync(openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      writers.set(name, createWriter(join(dir, name)));
      return name;
    }
  };
  const record: Recorder = (name, trace_id) => {
    const recording = unitOfWork(log, "record", { path: join(dir, name) }, startSpan(trace_id));
    const counts = { events_written: 0, bytes_written: 0, events_failed: 0 };
    // Whether the line was appended: a write's failure is counted, and is the recording's first failure if none came before.
    const appended = (line: Buffer) => {
      try {
        writerOf(name).append(line);
      } catch (error) {
        counts.events_failed++;
        recording.fail(error);
        return false;
      }
      counts.events_written++;
      counts.bytes_written += line.length;
      return true;
    };
    return (seen) => {
      const told = appended(eventLine(trace_id, seen)) ? listeners : [];
      if (seen.type === "end") recording.end({ outcome: "ok" }, () => ({ counts }));
      // The listeners are told after the event is written, so one that throws neither counts as a failed write nor
      // loses the recording's event.
      for (const listener of told) listener(name);
    };
  };
  const files = async () => (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  const sizeOf = (name: string) => stat(join(dir, name)).then(({ size }) => size, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? 0 : Promise.reject(error)));
  return {
    dir,
    run,
    record,
    create,
    readable: (name) => {
      const writer = writers.get(name);
      if (writer === undefined) throw new Error(`${name}: this run holds no writer for it`);
      return writer.written();
    },
    follows: (name) => writers.has(name),
    onWritten: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    listed: async () => {
      const names = await files();
      const sizes = await Promise.all(names.map(sizeOf));
      return names.filter((_, index) => sizes[index]! > 0);
    },
    // [LAW:parse-dont-validate] [LAW:single-enforcer] Nothing else a reader asks for reaches the filesystem, and a
    // case-insensitive filesystem cannot open the run's recording by another spelling and serve it as finished. The run's
    // own are known in memory, so the directory is listed only for a name it does not hold. A name that is neither, a
    // typo or one nothing made, is not waited on.
    named: async (asked) => (writers.has(asked) || (await files()).includes(asked) ? (asked as ReadableName) : undefined),
    measure: (name) => recordedLength(join(dir, name)),
    read: async (name, position, length) => {
      await using file = await open(join(dir, name));
      const { bytesRead, buffer } = await file.read(Buffer.alloc(length), 0, length, position);
      return buffer.subarray(0, bytesRead);
    },
  };
}
