import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "./exchanges.ts";

const timestamp = "2026-11-13T08:00:00.000Z";
const request = (trace_id: string, url: string): RecordedEvent => ({ timestamp, trace_id, type: "request", method: "POST", url, http_version: "1.1", headers: [] });
const body = (trace_id: string): RecordedEvent => ({ timestamp, trace_id, type: "response_body", base64: "e30=" });
const response = (trace_id: string, status: number): RecordedEvent => ({ timestamp, trace_id, type: "response", status, reason: "", http_version: "1.1", headers: [] });
const end = (trace_id: string): RecordedEvent => ({ timestamp, trace_id, type: "end", outcome: "ok" });

const empty = { head: undefined, body: [], trailers: undefined };

describe("exchanges", () => {
  it("joins overlapping exchanges' events by trace, in the order the exchanges began", () => {
    const events = [request("a", "/v1/messages"), request("b", "/v1/models"), response("b", 200), response("a", 529), body("a"), end("b"), end("a")];
    expect(exchanges(events)).toEqual([
      { trace_id: "a", request: { ...empty, head: events[0] }, response: { head: events[3], body: [events[4]], trailers: undefined }, end: events[6], latest: events[6] },
      { trace_id: "b", request: { ...empty, head: events[1] }, response: { ...empty, head: events[2] }, end: events[5], latest: events[5] },
    ]);
  });

  it("holds an exchange in flight with no response or end yet", () => {
    const events = [request("a", "/v1/messages")];
    expect(exchanges(events)).toEqual([{ trace_id: "a", request: { ...empty, head: events[0] }, response: empty, end: undefined, latest: events[0] }]);
  });

  it("holds an exchange whose request was not recorded, with what was", () => {
    const events = [response("a", 200), body("a"), end("a")];
    expect(exchanges(events)).toEqual([{ trace_id: "a", request: empty, response: { head: events[0], body: [events[1]], trailers: undefined }, end: events[2], latest: events[2] }]);
  });
});
