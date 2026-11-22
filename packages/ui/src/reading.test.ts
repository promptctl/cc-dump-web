import { describe as said } from "@cc-dump/log/describe";
import { eventsWritten } from "@cc-dump/log/testing";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import type { Reader } from "./connection/connection.ts";
import { createFormatter, type FormattedExchange } from "./format/format.ts";
import { onScreen, readRecording, type Frames, type OpenRecording, type Reading } from "./reading.ts";
import { exchanges, recordedAt } from "./testing.ts";

const agent = "20261113T080000.000Z.jsonl";
const at = recordedAt("2026-11-13T08:00:00.000Z");
const event = (n: number): RecordedEvent => ({ ...at(`t${n}`), type: "request_body", base64: "" });
const end = (n: number): RecordedEvent => ({ ...at(`t${n}`), type: "end", outcome: "ok" });
// What a read of `events` shows: them, formatted.
const formatted = (events: RecordedEvent[]) => createFormatter()(exchanges(events));

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

// Frames the test runs by hand, as requestAnimationFrame schedules them: each call its own frame, cancelled only by its
// own handle.
function handFrames() {
  const scheduled = new Map<object, () => void>();
  const frames: Frames = (callback) => {
    const handle = {};
    scheduled.set(handle, callback);
    return () => void scheduled.delete(handle);
  };
  const run = () => {
    const due = [...scheduled.values()];
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
  const shown: FormattedExchange[][] = [];
  const states: Reading[] = [];
  const abort = new AbortController();
  const { events, log } = eventsWritten();
  readRecording(connection, log, open, (formatted) => void shown.push(formatted), frames.frames, abort.signal, (reading) => states.push(reading));
  let offset = 0;
  const deliver = (...events: RecordedEvent[]) => events.forEach((event) => reads[0]!.reader.event(event, (offset += 100)));
  return { reads, frames, shown, states, abort, deliver, events };
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
    expect(shown).toEqual([[], formatted([1, 2, 3].map(event)), formatted([1, 2, 3, 4].map(event))]);
    expect(states).toEqual([{ state: "reading", name: agent }]);
  });

  it("shows the many events of one trace between frames in one frame", () => {
    const { frames, shown, deliver } = started();
    deliver(event(1), event(1), event(1));
    expect(frames.pending()).toBe(1);
    frames.run();
    deliver(event(1), event(1));
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(shown).toEqual([[], formatted([1, 1, 1].map(event)), formatted([1, 1, 1, 1, 1].map(event))]);
  });

  it("shows what is pending before it reports its end, and no frame of it runs after", () => {
    const { reads, frames, shown, states, deliver } = started();
    deliver(...[1, 2].map(event));
    reads[0]!.reader.end({ unterminated_bytes: 3 });
    expect(shown).toEqual([[], formatted([1, 2].map(event))]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "ended", name: agent, end: { unterminated_bytes: 3 } }]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("shows what is pending before it reports its failure", () => {
    const { reads, frames, shown, states, deliver } = started();
    const error = new Error("refused");
    deliver(event(1));
    reads[0]!.reader.failed(error);
    expect(shown).toEqual([[], formatted([event(1)])]);
    expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("fails on an event that breaks the shape the proxy writes, naming where it ends, after showing what came before, and ends the connection's read", () => {
    const { reads, frames, shown, states, deliver } = started();
    deliver(event(1), end(1), event(2), event(1));
    expect(shown).toEqual([[], formatted([event(1), end(1), event(2)])]);
    expect(states.map((reading) => (reading.state === "failed" ? said(reading.error) : reading))).toEqual([
      { state: "reading", name: agent },
      `${agent}: the event ending at byte 400: trace t1's request_body follows its trace's end`,
    ]);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("writes one event as it ends: ended, with the end the proxy gave; failed, with its failure; left by its reader; each with the exchanges it read", () => {
    const ended = started();
    ended.deliver(event(1), event(2));
    ended.reads[0]!.reader.end({ unterminated_bytes: 3 });
    ended.abort.abort();
    expect(ended.events).toEqual([expect.objectContaining({ event: "recording_read", name: agent, outcome: "ok", exchanges: 2, unterminated_bytes: 3 })]);
    const failed = started();
    failed.deliver(event(1), end(1), event(1));
    expect(failed.events).toEqual([
      expect.objectContaining({ event: "recording_read", name: agent, outcome: "error", error: `${agent}: the event ending at byte 300: trace t1's request_body follows its trace's end`, exchanges: 1 }),
    ]);
    const left = started();
    left.abort.abort();
    expect(left.events).toEqual([expect.objectContaining({ event: "recording_read", name: agent, outcome: "aborted", exchanges: 0 })]);
    // No recording open is no read, and writes nothing.
    expect(started(null).events).toEqual([]);
  });

  it("throws the reason of a signal aborted before it begins, as the connection's read does, showing and writing no read", () => {
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    const { events, log } = eventsWritten();
    const told: unknown[] = [];
    expect(() => readRecording(fakeConnection().connection, log, agent, (shown) => told.push(shown), handFrames().frames, abort.signal, (reading) => told.push(reading))).toThrow("gone");
    expect(told).toEqual([]);
    expect(events).toEqual([]);
  });

  it("leaves a frame's exchanges as they were when later events change the exchange", () => {
    const { frames, shown, deliver } = started();
    deliver(event(1));
    frames.run();
    const first = structuredClone(shown[1]!);
    deliver(event(1), end(1));
    frames.run();
    expect(shown[1]).toEqual(first);
    expect(shown[2]).toEqual(formatted([event(1), event(1), end(1)]));
  });

  // The read holds what an ended exchange showed and none of its events, and an exchange before it that turns out to be
  // no Messages request moves it among those shown.
  it("shows an ended exchange as its body made it in every frame after the one it ended in", () => {
    const { frames, shown, deliver } = started();
    const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hi." }] })).toString("base64");
    const before: RecordedEvent[] = [
      { ...at("t0"), type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [] },
      { ...at("t1"), type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
      { ...at("t1"), type: "request_body", base64: body },
      { ...at("t1"), type: "request_trailers", headers: [] },
      end(1),
    ];
    const models: RecordedEvent = { ...at("t0"), type: "request", method: "GET", url: "/v1/models", http_version: "1.1", headers: [] };
    deliver(...before);
    frames.run();
    deliver(models);
    frames.run();
    expect(shown[1]).toEqual(formatted(before));
    expect(shown[2]).toEqual(formatted([...before, models]));
    expect(shown[2]![0]!.groups.at(-2)!.blocks.map(({ parts }) => parts)).toEqual([[{ id: "text", kind: "text", form: "markdown", text: "Hi." }]]);
  });

  // [LAW:verifiable-goals] The ticket's goal, a recording's memory growing with what its history holds: a body event the
  // read no longer needs is collectable, and one it still needs is not, so the first cannot pass by the test missing it.
  it("holds the body events of the exchanges in flight and none of an ended exchange's", async () => {
    const collect = globalThis.gc;
    if (collect === undefined) throw new Error("garbage collection is not exposed: node takes --expose-gc from vitest.config.ts");
    const { frames, deliver } = started();
    const sent = (n: number, ending: boolean) => {
      const chunk: RecordedEvent = { ...at(`t${n}`), type: "request_body", base64: Buffer.from("x".repeat(1000)).toString("base64") };
      deliver(event(n), chunk, ...(ending ? [end(n)] : []));
      return new WeakRef(chunk);
    };
    const [flying, ended] = [sent(1, false), sent(2, true)];
    frames.run();
    // A WeakRef's target is kept alive for the job that made it.
    await new Promise((resolve) => setTimeout(resolve));
    collect();
    expect([flying.deref() !== undefined, ended.deref() !== undefined]).toEqual([true, false]);
  });

  it("ends as failed, with what it threw, when showing what is pending throws, at a frame and at its end", () => {
    const error = new Error("sink broke");
    // The list it is shown as the read begins is empty, and is not a frame.
    const sink = (shown: FormattedExchange[]) => {
      if (shown.length > 0) throw error;
    };
    const begun = () => {
      const { connection, reads } = fakeConnection();
      const frames = handFrames();
      const states: Reading[] = [];
      readRecording(connection, eventsWritten().log, agent, sink, frames.frames, new AbortController().signal, (reading) => states.push(reading));
      const request: RecordedEvent = { ...at("t1"), type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] };
      reads[0]!.reader.event(request, 100);
      return { reader: reads[0]!.reader, signal: reads[0]!.signal, frames, states };
    };
    const atFrame = begun();
    atFrame.frames.run();
    const atEnd = begun();
    atEnd.reader.end({ unterminated_bytes: 0 });
    for (const { states, signal } of [atFrame, atEnd]) {
      expect(states).toEqual([{ state: "reading", name: agent }, { state: "failed", error }]);
      expect(signal.aborted).toBe(true);
    }
  });

  it("keeps both when the read fails and showing what is pending fails with it: the refusal first, what showed it as its cause", () => {
    const broke = new Error("sink broke");
    const { connection, reads } = fakeConnection();
    const states: Reading[] = [];
    const sink = (shown: FormattedExchange[]) => {
      if (shown.length > 0) throw broke;
    };
    readRecording(connection, eventsWritten().log, agent, sink, handFrames().frames, new AbortController().signal, (reading) => states.push(reading));
    const request: RecordedEvent = { ...at("t1"), type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] };
    const { reader } = reads[0]!;
    reader.event(request, 100);
    reader.event(end(1), 200);
    reader.event(event(1), 300);
    const failed = states.at(-1)!;
    expect(failed).toMatchObject({ state: "failed", error: { cause: broke } });
    expect(failed.state === "failed" && said(failed.error)).toMatch(/the event ending at byte 300: trace t1's request_body follows its trace's end, and showing what it read failed: sink broke$/);
    expect(reads[0]!.signal.aborted).toBe(true);
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
    readRecording({ read: (_name, reader) => reader.failed(error) }, eventsWritten().log, agent, () => {}, handFrames().frames, new AbortController().signal, (reading) => states.push(reading));
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
