import { exchanges, recordedAt } from "../testing.ts";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { createFormatter } from "../format/format.ts";
import { createHistory } from "./history.ts";
import { failuresOf, mostOf, partedOf, stackOf, titleOf } from "./strip.ts";

const timestamp = "2026-11-16T16:00:00.000Z";
const at = recordedAt(timestamp);
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const request = (trace: string, messages: unknown[]): RecordedEvent[] => [
  { ...at(trace), type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] },
  { ...at(trace), type: "request_body", base64: base64({ model: "claude-opus-5-5", messages }) },
  { ...at(trace), type: "request_trailers", headers: [] },
];
const answered = (trace: string, usage: object): RecordedEvent[] => [
  { ...at(trace), type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { ...at(trace), type: "response_body", base64: base64({ id: `msg_${trace}`, type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage }) },
  { ...at(trace), type: "response_trailers", headers: [] },
  { ...at(trace), type: "end", outcome: "ok" },
];
const ask = { role: "user", content: [{ type: "text", text: "Read it." }] };
const call = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] };
const result = (fields: object) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", ...fields }] });
const segmentsOf = (events: RecordedEvent[]) => createHistory()(createFormatter()(exchanges(events))).segments;

describe("failuresOf", () => {
  it("marks the step that brought a tool's failed result, and not the steps that resend it", () => {
    const segments = segmentsOf([...request("t1", [ask]), ...request("t2", [ask, call, result({ is_error: true, content: "ENOENT" })]), ...request("t3", [ask, call, result({ is_error: true, content: "ENOENT" }), ask])]);
    expect(failuresOf(segments).map(({ tool }) => tool)).toEqual([false, true, false]);
  });

  it("marks no step whose tool's result did not fail", () => {
    const failures = failuresOf(segmentsOf([...request("t1", [ask]), ...request("t2", [ask, call, result({ content: "ok" })])]));
    expect(failures[1]).toEqual({ exchange: false, tool: false });
  });

  it("marks the step that brought a failed result as the next version of one its line already holds", () => {
    const segments = segmentsOf([...request("t1", [ask, call, result({ content: "ok" })]), ...request("t2", [ask, call, result({ is_error: true, content: "ENOENT" })])]);
    expect(failuresOf(segments).map(({ tool }) => tool)).toEqual([false, true]);
  });
});

describe("a mark's stack", () => {
  const unknown = { input: undefined, cacheRead: undefined, cacheWritten: undefined, output: undefined };
  const parts = (uncached: number, cacheRead: number, cacheWritten: number, output: number) => [
    { kind: "uncached", count: uncached },
    { kind: "cacheRead", count: cacheRead },
    { kind: "cacheWritten", count: cacheWritten },
    { kind: "output", count: output },
  ];

  it("is no height and four parts of nothing while nothing is known, as before any step's tokens are", () => {
    expect([mostOf([]), stackOf(unknown, mostOf([]))]).toEqual([0, { height: 0, parts: parts(0, 0, 0, 0) }]);
  });

  it("stacks the input the cache did not hold, the cache read, the cache written and the output, from the bottom", () => {
    expect(stackOf({ input: 1000, cacheRead: 700, cacheWritten: 200, output: 50 }, 2100)).toEqual({ height: 0.5, parts: parts(100, 700, 200, 50) });
  });

  it("is as tall as the strip at the largest step's tokens, which are its input and its output", () => {
    const usage = { input_tokens: 300, cache_read_input_tokens: 600, cache_creation_input_tokens: 100, output_tokens: 40 };
    const segments = segmentsOf([
      ...request("t1", [ask]),
      ...answered("t1", { input_tokens: 10, output_tokens: 5 }),
      ...request("t2", [ask]),
      ...answered("t2", usage),
    ]);
    const most = mostOf(segments);
    expect([most, stackOf(segments[1]!.formatted.facts, most).height, stackOf(segments[0]!.formatted.facts, most).height]).toEqual([1040, 1, 15 / 1040]);
  });

  it("holds a streaming step's cache and output while its input is not known yet", () => {
    expect(stackOf({ ...unknown, cacheRead: 30, output: 10 }, 80)).toEqual({ height: 0.5, parts: parts(0, 30, 0, 10) });
  });
});

describe("titleOf", () => {
  it("says the exchange line's facts known, that the column does not list the step, and what failed", () => {
    const [segment] = segmentsOf(request("t1", [ask]));
    const title = titleOf(3, segment!.formatted, false, { exchange: false, tool: true });
    expect(title.split(" · ")).toEqual(["3", expect.stringMatching(/\d\d:\d\d:\d\d/), "opus-5-5", "not in the column", "a tool failed"]);
    expect(titleOf(3, segment!.formatted, true, { exchange: false, tool: false }).split(" · ")).toEqual(["3", expect.stringMatching(/\d\d:\d\d:\d\d/), "opus-5-5"]);
  });
});

describe("partedOf", () => {
  it("is the steps that stand after what another step stands after, and no step that alone follows one", () => {
    const answer = { role: "assistant", content: [{ type: "text", text: "Read." }] };
    const again = { role: "user", content: [{ type: "text", text: "Again." }] };
    const other = { role: "user", content: [{ type: "text", text: "Another way." }] };
    // The second and the third each resend the first and go on their own way; the fourth follows the third alone.
    const segments = segmentsOf([
      ...request("t1", [ask]),
      ...request("t2", [ask, answer, again]),
      ...request("t3", [ask, answer, other]),
      ...request("t4", [ask, answer, other, answer, again]),
    ]);
    expect([...partedOf(segments)]).toEqual([2, 3]);
  });
});
