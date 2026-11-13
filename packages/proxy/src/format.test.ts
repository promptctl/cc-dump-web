import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseListings, parseRecordedEvent, parseRecordingEnd } from "./format.ts";
import { createRecording, type Seen } from "./recording.ts";

// Every kind of event the recorder writes, each ending among them.
const seen: Seen[] = [
  { type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: [["Content-Type", "application/json"], ["X-Twice", "a"], ["x-twice", "b"]] },
  { type: "request_body", chunk: Buffer.from('{"model":"x"}') },
  { type: "request_trailers", headers: [] },
  { type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["content-type", "text/event-stream"]] },
  { type: "response_body", chunk: Buffer.from([0x1f, 0x8b, 0x00, 0xff]) },
  { type: "response_trailers", headers: [["x-checksum", "abc"]] },
  { type: "end", outcome: "ok" },
  { type: "end", outcome: "aborted" },
  { type: "end", outcome: "stopped" },
  { type: "end", outcome: "error", error: "ECONNRESET: socket hang up" },
];

describe("parseRecordedEvent", () => {
  it("reads back every event the recorder wrote as it was written", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const recording = createRecording(() => {}, join(dir, "run.jsonl"));
    const record = recording.record("4bf92f3577b34da6a3ce929d0e0e4736");
    seen.forEach(record);
    const lines = readFileSync(recording.path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(seen.length);
    for (const line of lines) expect(parseRecordedEvent(line)).toEqual(JSON.parse(line));
  });

  const event = { timestamp: "2026-11-13T08:00:00.000Z", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" };
  it.each([
    ["not json", "{", "recorded event: is not JSON"],
    ["not an object", "[]", "recorded event: is not an object"],
    ["an unknown type", { ...event, type: "response_footer" }, "recorded event: type is not one of request, "],
    ["a missing field", { ...event, type: "response", reason: "OK", http_version: "1.1", headers: [] }, "recorded response event: status is not an integer"],
    ["a field of the wrong type", { ...event, type: "request_body", base64: 7 }, "recorded request_body event: base64 is not a string"],
    ["a malformed header", { ...event, type: "request_trailers", headers: [["x-one"]] }, "recorded request_trailers event: headers is not a list of [name, value] string pairs"],
    ["an unknown outcome", { ...event, type: "end", outcome: "gone" }, "recorded end event: outcome is not one of ok, aborted, stopped, error"],
    ["an error ending without its error", { ...event, type: "end", outcome: "error" }, "recorded end event: error is not a string"],
  ])("refuses %s, naming what does not fit", (_, line, message) => {
    expect(() => parseRecordedEvent(typeof line === "string" ? line : JSON.stringify(line))).toThrow(message);
  });
});

describe("the reader's messages", () => {
  it("reads back a recordings list and a recording's end", () => {
    const listings = [
      { name: "20261113T080000.000Z.jsonl", live: false },
      { name: "20261113T090000.000Z.jsonl", live: true },
    ];
    expect(parseListings(JSON.stringify(listings))).toEqual(listings);
    expect(parseRecordingEnd(JSON.stringify({ unterminated_bytes: 12 }))).toEqual({ unterminated_bytes: 12 });
  });

  it("refuses a list or an end of another shape", () => {
    expect(() => parseListings("{}")).toThrow("recordings list: is not an array");
    expect(() => parseListings('[{"name":"a.jsonl","live":"yes"}]')).toThrow("recordings list entry: live is not a boolean");
    expect(() => parseRecordingEnd('{"unterminated_bytes":1.5}')).toThrow("recording end: unterminated_bytes is not an integer");
  });
});
