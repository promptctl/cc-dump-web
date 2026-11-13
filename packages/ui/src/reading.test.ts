import type { Listing, RecordedEvent } from "@cc-dump/proxy/format";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Reader } from "./connection/connection.ts";
import { readLive, type Frames, type Reading } from "./reading.ts";

const live: Listing = { name: "20261113T090000.000Z.jsonl", live: true };
const event = (n: number): RecordedEvent => ({ timestamp: "2026-11-13T08:00:00.000Z", trace_id: `t${n}`, type: "request_body", base64: "" });

// A connection the test drives: it lists `listings`, or fails with it when it is an error, and hands the test each
// read's reader.
function fakeConnection(listings: Listing[] | Error = [{ name: "20261113T080000.000Z.jsonl", live: false }, live]) {
  const reads: { name: string; reader: Reader }[] = [];
  const connection: Parameters<typeof readLive>[0] = {
    recordings: (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        void setImmediate().then(() => (listings instanceof Error ? reject(listings) : resolve(listings)));
      }),
    read: (name, reader) => void reads.push({ name, reader }),
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

// readLive into a sink that records its calls, with every state it reported.
async function started(listings?: Listing[] | Error) {
  const { connection, reads } = fakeConnection(listings);
  const frames = handFrames();
  const calls: (["reset"] | ["append", RecordedEvent[]])[] = [];
  const sink = { reset: () => void calls.push(["reset"]), append: (batch: RecordedEvent[]) => void calls.push(["append", batch]) };
  const states: Reading[] = [];
  const abort = new AbortController();
  readLive(connection, sink, frames.frames, abort.signal, (reading) => states.push(reading));
  await setImmediate();
  await setImmediate();
  return { reads, frames, calls, states, abort };
}

describe("readLive", () => {
  it("reads the listing marked live, appending the events that arrive between frames in one call", async () => {
    const { reads, frames, calls, states } = await started();
    expect(reads.map(({ name }) => name)).toEqual([live.name]);
    const { reader } = reads[0]!;
    [1, 2, 3].map(event).forEach(reader.event);
    expect(calls).toEqual([["reset"]]);
    frames.run();
    reader.event(event(4));
    frames.run();
    expect(calls).toEqual([["reset"], ["append", [1, 2, 3].map(event)], ["append", [event(4)]]]);
    expect(states).toEqual([{ state: "reading" }]);
  });

  it("appends what is pending before it reports its end, and no frame of it runs after", async () => {
    const { reads, frames, calls, states } = await started();
    const { reader } = reads[0]!;
    [1, 2].map(event).forEach(reader.event);
    reader.end({ unterminated_bytes: 3 });
    expect(calls).toEqual([["reset"], ["append", [1, 2].map(event)]]);
    expect(states).toEqual([{ state: "reading" }, { state: "ended", end: { unterminated_bytes: 3 } }]);
    expect(frames.pending()).toBe(0);
  });

  it("appends what is pending before it reports its failure", async () => {
    const { reads, frames, calls, states } = await started();
    const { reader } = reads[0]!;
    const error = new Error("refused");
    reader.event(event(1));
    reader.failed(error);
    expect(calls).toEqual([["reset"], ["append", [event(1)]]]);
    expect(states).toEqual([{ state: "reading" }, { state: "failed", error }]);
    expect(frames.pending()).toBe(0);
  });

  it("cancels its pending frame when aborted, and reports nothing", async () => {
    const { reads, frames, calls, states, abort } = await started();
    reads[0]!.reader.event(event(1));
    abort.abort();
    expect(frames.pending()).toBe(0);
    expect(calls).toEqual([["reset"]]);
    expect(states).toEqual([{ state: "reading" }]);
  });

  it("reports a list that fails, or one without exactly one live recording, as failed", async () => {
    const error = new Error("GET /recordings: 500");
    expect((await started(error)).states).toEqual([{ state: "reading" }, { state: "failed", error }]);
    for (const listings of [[], [live, { ...live, name: "20261113T100000.000Z.jsonl" }]]) {
      const { reads, states } = await started(listings);
      expect(reads).toEqual([]);
      expect(states).toEqual([{ state: "reading" }, { state: "failed", error: new Error(`GET /recordings listed ${listings.length} live recordings, not one`) }]);
    }
  });

  it("reports nothing when aborted while listing", async () => {
    const { connection, reads } = fakeConnection();
    const states: Reading[] = [];
    const abort = new AbortController();
    readLive(connection, { reset: () => {}, append: () => {} }, handFrames().frames, abort.signal, (reading) => states.push(reading));
    abort.abort();
    await setImmediate();
    await setImmediate();
    expect(reads).toEqual([]);
    expect(states).toEqual([{ state: "reading" }]);
  });
});
