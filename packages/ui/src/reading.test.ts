import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import type { Reader } from "./connection/connection.ts";
import { onScreen, readRecording, type Frames, type OpenRecording, type Reading } from "./reading.ts";

const agent = "20261113T080000.000Z.jsonl";
const event = (n: number): RecordedEvent => ({ timestamp: "2026-11-13T08:00:00.000Z", trace_id: `t${n}`, type: "request_body", base64: "" });

// A connection the test drives: it hands the test each read's reader. A read begun aborted throws, as the browser's does.
function fakeConnection() {
  const reads: { name: string; reader: Reader }[] = [];
  const connection: Parameters<typeof readRecording>[0] = {
    read: (name, reader, signal) => {
      signal.throwIfAborted();
      reads.push({ name, reader });
    },
  };
  return { connection, reads };
}

// Frames the test runs by hand.
function handFrames() {
  const scheduled = new Set<() => void>();
  const frames: Frames = (callback) => {
    scheduled.add(callback);
    return () => void scheduled.delete(callback);
  };
  const run = () => {
    const due = [...scheduled];
    scheduled.clear();
    due.forEach((callback) => callback());
  };
  return { frames, run, pending: () => scheduled.size };
}

// readRecording of `open` into a sink that records its calls, with every state it reported.
function started(open: OpenRecording = agent) {
  const { connection, reads } = fakeConnection();
  const frames = handFrames();
  const calls: (["reset"] | ["append", RecordedEvent[]])[] = [];
  const sink = { reset: () => void calls.push(["reset"]), append: (batch: RecordedEvent[]) => void calls.push(["append", batch]) };
  const states: Reading[] = [];
  const abort = new AbortController();
  readRecording(connection, open, sink, frames.frames, abort.signal, (reading) => states.push(reading));
  return { reads, frames, calls, states, abort };
}

describe("readRecording", () => {
  it("reads the recording open by its name, appending the events that arrive between frames in one call", () => {
    const { reads, frames, calls, states } = started();
    expect(reads.map(({ name }) => name)).toEqual([agent]);
    const { reader } = reads[0]!;
    [1, 2, 3].map(event).forEach(reader.event);
    expect(calls).toEqual([["reset"]]);
    frames.run();
    reader.event(event(4));
    frames.run();
    expect(calls).toEqual([["reset"], ["append", [1, 2, 3].map(event)], ["append", [event(4)]]]);
    expect(states).toEqual([{ state: "reading", name: agent }]);
  });

  it("appends what is pending before it reports its end, and no frame of it runs after", () => {
    const { reads, frames, calls, states } = started();
    const { reader } = reads[0]!;
    [1, 2].map(event).forEach(reader.event);
    reader.end({ unterminated_bytes: 3 });
    expect(calls).toEqual([["reset"], ["append", [1, 2].map(event)]]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "ended", name: agent, end: { unterminated_bytes: 3 } }]);
    expect(frames.pending()).toBe(0);
  });

  it("appends what is pending before it reports its failure", () => {
    const { reads, frames, calls, states } = started();
    const { reader } = reads[0]!;
    const error = new Error("refused");
    reader.event(event(1));
    reader.failed(error);
    expect(calls).toEqual([["reset"], ["append", [event(1)]]]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
    expect(frames.pending()).toBe(0);
  });

  it("cancels its pending frame when aborted, and reports nothing", () => {
    const { reads, frames, calls, states, abort } = started();
    reads[0]!.reader.event(event(1));
    abort.abort();
    expect(frames.pending()).toBe(0);
    expect(calls).toEqual([["reset"]]);
    expect(states).toEqual([{ state: "reading", name: agent }]);
  });

  it("ends in a failure the read reports as it begins", () => {
    const error = new Error("GET /recordings/x: not served");
    const states: Reading[] = [];
    readRecording({ read: (_name, reader) => reader.failed(error) }, agent, { reset: () => {}, append: () => {} }, handFrames().frames, new AbortController().signal, (reading) => states.push(reading));
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
  });

  it("empties what is shown and reads nothing when no recording is open", () => {
    const { reads, calls, states } = started(null);
    expect(reads).toEqual([]);
    expect(calls).toEqual([["reset"]]);
    expect(states).toEqual([{ state: "none" }]);
  });
});

describe("the recording on screen", () => {
  it("is the one being read or read to its end, by its name", () => {
    expect(onScreen({ state: "reading", name: agent })).toBe(agent);
    expect(onScreen({ state: "ended", name: agent, end: { unterminated_bytes: 0 } })).toBe(agent);
  });

  it("is none when no recording is open, or the read failed", () => {
    expect([onScreen({ state: "none" }), onScreen({ state: "failed", error: new Error("refused") })]).toEqual([undefined, undefined]);
  });
});
