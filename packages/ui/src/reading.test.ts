import { describe as said } from "@cc-dump/log/describe";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import type { Reader } from "./connection/connection.ts";
import type { Exchange } from "./exchanges.ts";
import { onScreen, readRecording, type Frames, type OpenRecording, type Reading } from "./reading.ts";
import { exchanges, recordedAt } from "./testing.ts";

const agent = "20261113T080000.000Z.jsonl";
const at = recordedAt("2026-11-13T08:00:00.000Z");
const event = (n: number): RecordedEvent => ({ ...at(`t${n}`), type: "request_body", base64: "" });
const end = (n: number): RecordedEvent => ({ ...at(`t${n}`), type: "end", outcome: "ok" });

// A connection the test drives: it hands the test each read's reader, and its signal. A read begun aborted throws, as
// the browser's does.
function fakeConnection() {
  const reads: { name: string; reader: Reader; signal: AbortSignal }[] = [];
  const connection: Parameters<typeof readRecording>[0] = {
    read: (name, reader, signal) => {
      signal.throwIfAborted();
      reads.push({ name, reader, signal });
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

// readRecording of `open` into a sink that keeps each list it was shown, with every state it reported. `deliver` hands
// the read events as the connection does, each with the offset its line ends at.
function started(open: OpenRecording = agent) {
  const { connection, reads } = fakeConnection();
  const frames = handFrames();
  const shown: Exchange[][] = [];
  const states: Reading[] = [];
  const abort = new AbortController();
  readRecording(connection, open, (exchanges) => void shown.push(exchanges), frames.frames, abort.signal, (reading) => states.push(reading));
  let offset = 0;
  const deliver = (...events: RecordedEvent[]) => events.forEach((event) => reads[0]!.reader.event(event, (offset += 100)));
  return { reads, frames, shown, states, abort, deliver };
}

describe("readRecording", () => {
  it("reads the recording open by its name, showing the exchanges changed between frames in one call", () => {
    const { reads, frames, shown, states, deliver } = started();
    expect(reads.map(({ name }) => name)).toEqual([agent]);
    deliver(...[1, 2, 3].map(event));
    expect(shown).toEqual([[]]);
    frames.run();
    deliver(event(4));
    frames.run();
    expect(shown).toEqual([[], exchanges([1, 2, 3].map(event)), exchanges([1, 2, 3, 4].map(event))]);
    expect(states).toEqual([{ state: "reading", name: agent }]);
  });

  it("shows what is pending before it reports its end, and no frame of it runs after", () => {
    const { reads, frames, shown, states, deliver } = started();
    deliver(...[1, 2].map(event));
    reads[0]!.reader.end({ unterminated_bytes: 3 });
    expect(shown).toEqual([[], exchanges([1, 2].map(event))]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "ended", name: agent, end: { unterminated_bytes: 3 } }]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("shows what is pending before it reports its failure", () => {
    const { reads, frames, shown, states, deliver } = started();
    const error = new Error("refused");
    deliver(event(1));
    reads[0]!.reader.failed(error);
    expect(shown).toEqual([[], exchanges([event(1)])]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("fails on an event that breaks the shape the proxy writes, naming where it ends, after showing what came before, and ends the connection's read", () => {
    const { reads, frames, shown, states, deliver } = started();
    deliver(event(1), end(1), event(2), event(1));
    expect(shown).toEqual([[], exchanges([event(1), end(1), event(2)])]);
    expect(states.map((reading) => (reading.state === "failed" ? said(reading.error) : reading))).toEqual([
      { state: "reading", name: agent },
      `${agent}: the event ending at byte 400: trace t1's request_body follows its trace's end`,
    ]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("throws the reason of a signal aborted before it begins, as the connection's read does", () => {
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    expect(() => readRecording(fakeConnection().connection, agent, () => {}, handFrames().frames, abort.signal, () => {})).toThrow("gone");
  });

  it("leaves a frame's exchanges as they were when later events change the exchange", () => {
    const { frames, shown, deliver } = started();
    deliver(event(1));
    frames.run();
    const first = structuredClone(shown[1]!);
    deliver(event(1), end(1));
    frames.run();
    expect(shown[1]).toEqual(first);
    expect(shown[2]).toEqual(exchanges([event(1), event(1), end(1)]));
  });

  it("cancels its pending frame when aborted, and reports nothing", () => {
    const { reads, frames, shown, states, abort, deliver } = started();
    deliver(event(1));
    abort.abort();
    expect(frames.pending()).toBe(0);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(shown).toEqual([[]]);
    expect(states).toEqual([{ state: "reading", name: agent }]);
  });

  it("ends in a failure the read reports as it begins", () => {
    const error = new Error("GET /recordings/x: not served");
    const states: Reading[] = [];
    readRecording({ read: (_name, reader) => reader.failed(error) }, agent, () => {}, handFrames().frames, new AbortController().signal, (reading) => states.push(reading));
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
  });

  it("empties what is shown and reads nothing when no recording is open", () => {
    const { reads, shown, states } = started(null);
    expect(reads).toEqual([]);
    expect(shown).toEqual([[]]);
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
