import { parseTraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { add, exchanges, type ByTrace } from "./exchanges.ts";

const timestamp = "2026-11-13T08:00:00.000Z";
const at = (trace: string) => ({ timestamp, trace_id: parseTraceId(trace) });
const request = (trace: string, url: string): RecordedEvent => ({ ...at(trace), type: "request", method: "POST", url, http_version: "1.1", headers: [] });
const requestBody = (trace: string): RecordedEvent => ({ ...at(trace), type: "request_body", base64: "e30=" });
const requestTrailers = (trace: string): RecordedEvent => ({ ...at(trace), type: "request_trailers", headers: [] });
const body = (trace: string): RecordedEvent => ({ ...at(trace), type: "response_body", base64: "e30=" });
const response = (trace: string, status: number): RecordedEvent => ({ ...at(trace), type: "response", status, reason: "", http_version: "1.1", headers: [] });
const trailers = (trace: string): RecordedEvent => ({ ...at(trace), type: "response_trailers", headers: [] });
const end = (trace: string): RecordedEvent => ({ ...at(trace), type: "end", outcome: "ok" });

const empty = { head: undefined, body: [], trailers: undefined, completedBy: undefined };

describe("exchanges", () => {
  it("joins overlapping exchanges' events by trace, in the order the exchanges began", () => {
    const events = [request("a", "/v1/messages"), request("b", "/v1/models"), response("b", 200), response("a", 529), body("a"), end("b"), end("a")];
    expect(exchanges(events)).toEqual([
      {
        trace_id: "a",
        request: { ...empty, head: events[0], completedBy: events[6] },
        response: { ...empty, head: events[3], body: [events[4]], completedBy: events[6] },
        end: events[6],
        first: events[0],
        latest: events[6],
      },
      {
        trace_id: "b",
        request: { ...empty, head: events[1], completedBy: events[5] },
        response: { ...empty, head: events[2], completedBy: events[5] },
        end: events[5],
        first: events[1],
        latest: events[5],
      },
    ]);
  });

  it("holds an exchange in flight with no response or end yet", () => {
    const events = [request("a", "/v1/messages")];
    expect(exchanges(events)).toEqual([{ trace_id: "a", request: { ...empty, head: events[0] }, response: empty, end: undefined, first: events[0], latest: events[0] }]);
  });

  it("holds an exchange whose request was not recorded, with what was", () => {
    const events = [response("a", 200), body("a"), end("a")];
    expect(exchanges(events)).toEqual([
      {
        trace_id: "a",
        request: empty,
        response: { ...empty, head: events[0], body: [events[1]], completedBy: events[2] },
        end: events[2],
        first: events[0],
        latest: events[2],
      },
    ]);
  });

  it("completes a side at its trailers, or at the end when it began and they were never recorded", () => {
    const events = [request("a", "/v1/messages"), response("a", 200), body("a"), trailers("a"), end("a")];
    const [exchange] = exchanges(events);
    expect(exchange!.response).toEqual({ head: events[1], body: [events[2]], trailers: events[3], completedBy: events[3] });
    expect(exchange!.request).toEqual({ ...empty, head: events[0], completedBy: events[4] });
  });

  it("takes a body before its head, as the recorder writes it when the head's write fails", () => {
    const events = [body("a"), response("a", 200)];
    expect(exchanges(events)[0]!.response).toEqual({ ...empty, head: events[1], body: [events[0]] });
  });
});

describe("add", () => {
  it.each([
    ["a second request head", [request("a", "/")], request("a", "/"), "is a second head on its side"],
    ["a second response head", [response("a", 200)], response("a", 200), "is a second head on its side"],
    ["a second request trailers", [requestTrailers("a")], requestTrailers("a"), "follows its side's trailers"],
    ["a second response trailers", [trailers("a")], trailers("a"), "follows its side's trailers"],
    ["a request body after the request's trailers", [request("a", "/"), requestTrailers("a")], requestBody("a"), "follows its side's trailers"],
    ["a response head after the response's trailers", [trailers("a")], response("a", 200), "follows its side's trailers"],
    ["an event after its trace's end", [request("a", "/"), end("a")], response("a", 200), "follows its trace's end"],
    ["a second end", [end("a")], end("a"), "follows its trace's end"],
  ])("refuses %s, placing it nowhere", (_, placed, refused, said) => {
    const byTrace: ByTrace = new Map();
    for (const event of placed) expect(add(byTrace, event)).toBeUndefined();
    const before = structuredClone(byTrace);
    expect(add(byTrace, refused)).toBe(said);
    expect(byTrace).toEqual(before);
  });

  it("refuses an event of a new trace without beginning its exchange", () => {
    const byTrace: ByTrace = new Map();
    expect(add(byTrace, { ...end("a"), type: "nope" } as unknown as RecordedEvent)).toBe("is of no type a recording holds");
    expect(byTrace.size).toBe(0);
  });

  it("takes the other side's events after one side's trailers", () => {
    const byTrace: ByTrace = new Map();
    for (const event of [request("a", "/"), requestTrailers("a"), response("a", 200), body("a"), trailers("a"), end("a")]) expect(add(byTrace, event)).toBeUndefined();
  });

  it("fails the fold of a list on the first refusal, naming the event, its trace and its type", () => {
    expect(() => exchanges([request("a", "/"), end("a"), body("a")])).toThrow("event 3, trace a's response_body: follows its trace's end");
  });
});
