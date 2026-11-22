import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as said } from "@cc-dump/log/describe";
import { parseTraceId } from "@cc-dump/log/trace";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  agentBaseUrl,
  agentOf,
  offsetOf,
  parseListing,
  parseListings,
  parseProxyInfo,
  parseProxyStatus,
  parseRecordedEvent,
  parseRecordingEnd,
  parseRecordingName,
  recordingName,
  recordingStart,
  runRecordingName,
  type ProxyStatus,
} from "./format.ts";
import type { Seen } from "./recording.ts";
import { createRecordings } from "./recordings.ts";

// What `parse` is refused for, with every cause, as the UI shows it.
function refusal(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    return said(error);
  }
  throw new Error("not refused");
}

// Every kind of event the recorder writes, by trace, each ending among them: one exchange whole, and one of each other
// ending.
const seen: [trace: string, Seen[]][] = [
  [
    "4bf92f3577b34da6a3ce929d0e0e4736",
    [
      { type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: [["Content-Type", "application/json"], ["X-Twice", "a"], ["x-twice", "b"]] },
      { type: "request_body", chunk: Buffer.from('{"model":"x"}') },
      { type: "request_trailers", headers: [] },
      { type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["content-type", "text/event-stream"]] },
      { type: "response_body", chunk: Buffer.from([0x1f, 0x8b, 0x00, 0xff]) },
      { type: "response_trailers", headers: [["x-checksum", "abc"]] },
      { type: "end", outcome: "ok" },
    ],
  ],
  ["aborted", [{ type: "end", outcome: "aborted" }]],
  ["stopped", [{ type: "end", outcome: "stopped" }]],
  ["error", [{ type: "end", outcome: "error", error: "ECONNRESET: socket hang up" }]],
];

describe("parseRecordedEvent", () => {
  it("reads back every event the recorder wrote as it was seen, body chunks as their base64", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const recordings = createRecordings(() => {}, dir, "run.jsonl");
    for (const [trace, events] of seen) events.forEach(recordings.record("run.jsonl", parseTraceId(trace)));
    const lines = readFileSync(join(dir, "run.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.map(parseRecordedEvent)).toEqual(
      seen.flatMap(([trace, events]) =>
        events.map((event) => ({
          timestamp: expect.any(String),
          trace_id: trace,
          ...("chunk" in event ? { type: event.type, base64: event.chunk.toString("base64") } : event),
        })),
      ),
    );
  });

  const event = { timestamp: "2026-11-13T08:00:00.000Z", trace_id: "t1" };
  it.each([
    ["not json", "{", "recorded event: is not JSON"],
    ["not an object", "[]", "recorded event: is not an object"],
    ["an unknown type", { ...event, type: "response_footer" }, "recorded event: type: is not one of request, "],
    ["a missing field", { ...event, type: "response", reason: "OK", http_version: "1.1", headers: [] }, "trace t1's response: status: is missing"],
    ["a field of the wrong type", { ...event, type: "request_body", base64: 7 }, "trace t1's request_body: base64: is not a string"],
    ["a malformed header", { ...event, type: "request_trailers", headers: [["x-one"]] }, "trace t1's request_trailers: headers: is not a list of [name, value] string pairs"],
    ["a trace id that is not a word", { ...event, trace_id: "a/b", type: "end", outcome: "ok" }, `recorded end event: trace_id: "a/b" is not a word: one or more letters, digits, '-' or '_'`],
    ["a time that is not one", { ...event, timestamp: "yesterday", type: "end", outcome: "ok" }, "trace t1's end: timestamp: is not an ISO 8601 UTC time"],
    ["a day its month does not have", { ...event, timestamp: "2026-02-31T00:00:00.000Z", type: "end", outcome: "ok" }, "trace t1's end: timestamp: is not an ISO 8601 UTC time"],
    ["a time written as the proxy does not", { ...event, timestamp: "2026-11-13T08:00:00Z", type: "end", outcome: "ok" }, "trace t1's end: timestamp: is not an ISO 8601 UTC time"],
    ["an unknown outcome", { ...event, type: "end", outcome: "gone" }, "trace t1's end: outcome: is not one of ok, aborted, stopped, error"],
    ["an error ending without its error", { ...event, type: "end", outcome: "error" }, "trace t1's end: error: is missing"],
  ])("refuses %s, naming what does not fit", (_, line, message) => {
    expect(refusal(() => parseRecordedEvent(typeof line === "string" ? line : JSON.stringify(line)))).toContain(message);
  });
});

describe("a byte offset", () => {
  it("is a decimal integer a file can have, and nothing else", () => {
    expect(["0", "48213"].map(offsetOf)).toEqual([0, 48213]);
    expect(["", "-1", "1.5", "1e3", " 7", "0x10", String(2 ** 53)].map(offsetOf)).toEqual(Array(7).fill(undefined));
  });
});

describe("the reader's messages", () => {
  it("reads back a recordings list and a recording's end", () => {
    const listings = [{ name: "20261113T080000.000Z.jsonl" }, { name: "run-20261113T090000.000Z.jsonl" }];
    expect(parseListings(JSON.stringify(listings))).toEqual(listings);
    expect(parseListing(JSON.stringify(listings[0]))).toEqual(listings[0]);
    expect(parseRecordingEnd(JSON.stringify({ unterminated_bytes: 12 }))).toEqual({ unterminated_bytes: 12 });
  });

  it("refuses a list or an end of another shape", () => {
    expect(() => parseListings("{}")).toThrow("recordings list: is not an array");
    expect(() => parseListings('[{"name":7}]')).toThrow("recordings list entry: name: is not a string");
    expect(() => parseListing("[]")).toThrow("recording: is not an object");
    expect(() => parseListing('{"name":7}')).toThrow("recording: name: is not a string");
    expect(() => parseRecordingEnd('{"unterminated_bytes":1.5}')).toThrow("recording end: unterminated_bytes: is not an integer");
  });

  const info = { base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/", recordings: "/home/me/.local/share/cc-dump/recordings" };

  it("reads back each state of the proxy's status", () => {
    const statuses: ProxyStatus[] = [
      { info, source: { state: "watching", changed_source: ["/proxy/src/proxy.ts"] }, traffic: { in_flight: 0, last_request: null } },
      { info, source: { state: "failed", message: "EMFILE: too many open files, watch" }, traffic: { in_flight: 2, last_request: "2026-11-16T10:00:00.000Z" } },
    ];
    expect(statuses.map((status) => parseProxyStatus(JSON.stringify(status)))).toEqual(statuses);
  });

  it("refuses a status of another shape, the shapes before its traffic and its info were sent included", () => {
    const status = { info, source: { state: "watching", changed_source: [] }, traffic: { in_flight: 0, last_request: null } };
    const refused = (changed: object) => () => parseProxyStatus(JSON.stringify({ ...status, ...changed }));
    expect(() => parseProxyStatus('{"state":"watching","changed_source":[]}')).toThrow("proxy status: source: is missing");
    expect(refused({ source: { changed_source: [] } })).toThrow("proxy status: source: state: is missing");
    expect(refused({ source: { state: "watching", changed_source: [1] } })).toThrow("proxy status: source: changed_source: is not a list of strings");
    expect(refused({ source: { state: "failed", error: "EMFILE" } })).toThrow("proxy status: source: message: is missing");
    expect(refused({ traffic: undefined })).toThrow("proxy status: traffic: is missing");
    expect(refused({ traffic: { in_flight: 0.5, last_request: null } })).toThrow("proxy status: traffic: in_flight: is not an integer");
    for (const last_request of ["yesterday", "2026", "Nov 16 2026", "2026-11-16T10:00:00Z", "2026-11-16T10:00:00.000+01:00"]) {
      expect(refused({ traffic: { in_flight: 0, last_request } })).toThrow("proxy status: traffic: last_request: is not an ISO 8601 UTC time");
    }
    expect(refused({ info: undefined })).toThrow("proxy status: info: is missing");
    expect(refused({ info: { ...info, recordings: undefined } })).toThrow("proxy status: info: recordings: is missing");
  });

  it("reads back the proxy's info, and refuses info without the recordings' directory", () => {
    expect(parseProxyInfo(JSON.stringify(info))).toEqual(info);
    expect(() => parseProxyInfo('{"base_url":"http://127.0.0.1:3344","upstream":"https://api.anthropic.com/"}')).toThrow("proxy info: recordings: is missing");
  });
});

describe("a recording's name", () => {
  const start = new Date("2026-11-13T18:18:44.123Z");

  it("is a process's launch, or the proxy run's start, in ISO 8601 basic format, and gives its kind and start back", () => {
    expect(recordingName(start)).toBe("20261113T181844.123Z.jsonl");
    expect(runRecordingName(start)).toBe("run-20261113T181844.123Z.jsonl");
    expect(parseRecordingName(recordingName(start))).toEqual({ kind: "agent", start });
    expect(parseRecordingName(runRecordingName(start))).toEqual({ kind: "run", start });
    expect(recordingStart(recordingName(start))).toEqual(start);
  });

  it("is no agent's start when it is the run's", () => {
    expect(recordingStart(runRecordingName(start))).toBeUndefined();
  });

  it.each(["notes.jsonl", "20261113T181844Z.jsonl", "20261313T181844.123Z.jsonl", "20261113T181844.123Z.jsonl.jsonl", "run-run-20261113T181844.123Z.jsonl", "RUN-20261113T181844.123Z.jsonl"])(
    "gives no start for %s, which nothing named",
    (name) => {
      expect(parseRecordingName(name)).toBeUndefined();
      expect(recordingStart(name)).toBeUndefined();
    },
  );
});

describe("an agent's path", () => {
  const name = recordingName(new Date("2026-11-15T00:42:15.438Z"));

  it("is the proxy's base URL and the recording's name without its extension", () => {
    expect(agentBaseUrl("http://127.0.0.1:3399", name)).toBe("http://127.0.0.1:3399/agent/20261115T004215.438Z");
  });

  it.each(["/v1/messages?beta=true", "/api/hello", "/", "//double"])("names its recording and leaves the request's URL %s as the upstream knows it", (url) => {
    expect(agentOf(`/agent/20261115T004215.438Z${url}`)).toEqual({ name, url });
  });

  it.each([
    ["", "/"],
    ["?x=1", "/?x=1"],
    ["?", "/?"],
  ])("names its recording for a request to the base URL itself, %j, which is the upstream's %j", (rest, url) => {
    expect(agentOf(`/agent/20261115T004215.438Z${rest}`)).toEqual({ name, url });
  });

  it.each([
    "/v1/messages",
    "/agent/20261115T004215.438Z#fragment",
    "/agent/20261115T004215.438Zx",
    "/agent/20261115T004215.438Z.jsonl",
    "/agent/notes",
    "/agent/notes?x=1",
    "/agent/notes/v1/messages",
    "/agent/run-20261115T004215.438Z/v1/messages",
    "/agent//v1/messages",
    "/agents/20261115T004215.438Z/v1/messages",
  ])("names no agent in %s", (url) => {
    expect(agentOf(url)).toBeUndefined();
  });
});
