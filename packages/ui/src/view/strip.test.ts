import { parseTraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { createFormatter } from "../format/format.ts";
import { createHistory } from "./history.ts";
import { failuresOf, mostOf, partedOf, shapeOf, titleOf } from "./strip.ts";

const timestamp = "2026-11-16T16:00:00.000Z";
const at = (trace: string) => ({ timestamp, trace_id: parseTraceId(trace) });
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const request = (trace: string, messages: unknown[]): RecordedEvent[] => [
  { ...at(trace), type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] },
  { ...at(trace), type: "request_body", base64: base64({ model: "claude-opus-5-5", messages }) },
  { ...at(trace), type: "request_trailers", headers: [] },
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

describe("a mark's shape", () => {
  const most = mostOf([]);
  it("is the least while nothing is known, so every mark can still be seen and pressed", () => {
    expect([most, shapeOf({ output: undefined, duration: undefined }, most)]).toEqual([{ output: 0, duration: 0 }, { height: 0.25, opacity: 0.4 }]);
  });

  it("grows with its output and strengthens with its duration, against the most of any step", () => {
    const of = { output: 1000, duration: 20_000 };
    expect([shapeOf({ output: 1000, duration: 20_000 }, of), shapeOf({ output: 500, duration: 5000 }, of)]).toEqual([
      { height: 1, opacity: 1 },
      { height: 0.625, opacity: 0.55 },
    ]);
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
