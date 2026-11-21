import { exchanges } from "../testing.ts";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { createFormatter } from "../format/format.ts";
import { assistant, replied, call as toolCall, request as fixtureRequest, text, user } from "../../test/fixtures.ts";
import { createHistory } from "./history.ts";
import { failuresOf, mostOf, partedOf, stackOf, titleOf, wheelPixels } from "./strip.ts";

const request = (trace_id: string, messages: unknown[]) => fixtureRequest(trace_id, { model: "claude-opus-5-5", messages });
const ask = user(text("Read it."));
const call = assistant(toolCall("toolu_1", "Read", {}));
// A user message holding the Read call's result, with the fields given.
const result = (fields: object) => user({ type: "tool_result", tool_use_id: "toolu_1", ...fields });
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
  const unknown = { uncached: undefined, cacheRead: undefined, cacheWritten: undefined, output: undefined };
  const none = { output: 0, cacheWritten: 0, uncached: 0, cacheRead: 0 };

  it("is no tokens under no headroom while nothing is known, as before any step's tokens are", () => {
    expect([mostOf([]), stackOf(unknown, mostOf([]))]).toEqual([0, { counts: none, tokens: 0, headroom: 0 }]);
  });

  it("is each kind of the step's tokens as the API reported it, under what the largest step holds above them", () => {
    const counts = { uncached: 100, cacheRead: 700, cacheWritten: 200, output: 50 };
    expect(stackOf(counts, 2100)).toEqual({ counts, tokens: 1050, headroom: 1050 });
  });

  it("fills the strip at the largest step's tokens, which are its input and its output", () => {
    const usage = { input_tokens: 300, cache_read_input_tokens: 600, cache_creation_input_tokens: 100, output_tokens: 40 };
    const segments = segmentsOf([...request("t1", [ask]), ...replied("t1", { usage: { input_tokens: 10, output_tokens: 5 } }), ...request("t2", [ask]), ...replied("t2", { usage })]);
    const most = mostOf(segments);
    const [small, largest] = segments.map(({ formatted: { facts } }) => stackOf(facts, most));
    expect([most, largest, small!.headroom]).toEqual([1040, { counts: { uncached: 300, cacheRead: 600, cacheWritten: 100, output: 40 }, tokens: 1040, headroom: 0 }, 1025]);
  });

  it("draws a streaming step's counts reported so far, and none of those its message has not said yet", () => {
    expect(stackOf({ ...unknown, cacheRead: 30, output: 10 }, 80)).toEqual({ counts: { ...none, cacheRead: 30, output: 10 }, tokens: 40, headroom: 40 });
  });
});

describe("wheelPixels", () => {
  const sizes = { line: 16, page: 1200 };

  it("moves the strip by a vertical turn in pixels, lines or pages, as the DOM's delta mode says", () => {
    expect([0, 1, 2].map((deltaMode) => wheelPixels({ deltaX: 0, deltaY: -3, deltaMode }, sizes))).toEqual([-3, -48, -3600]);
  });

  it("leaves a turn that is mostly sideways to the browser, which scrolls the strip by it already", () => {
    expect([wheelPixels({ deltaX: 40, deltaY: 4, deltaMode: 0 }, sizes), wheelPixels({ deltaX: 4, deltaY: 40, deltaMode: 0 }, sizes)]).toEqual([0, 40]);
  });

  it("refuses a delta mode the DOM does not define", () => {
    expect(() => wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 3 }, sizes)).toThrow("a wheel's delta mode the DOM does not define: 3");
  });
});

describe("titleOf", () => {
  it("says the exchange line's facts known, that the column does not list the step, and what failed", () => {
    const [segment] = segmentsOf(request("t1", [ask]));
    const title = titleOf(3, segment!.formatted, false, { exchange: false, tool: true });
    expect(title.split(" · ")).toEqual(["3", expect.stringMatching(/\d\d:\d\d:\d\d/), "opus-5-5", "not in the column", "a tool failed"]);
    expect(titleOf(3, segment!.formatted, true, { exchange: false, tool: false }).split(" · ")).toEqual(["3", expect.stringMatching(/\d\d:\d\d:\d\d/), "opus-5-5"]);
  });

  it("says the step's input as its total, the uncached, the cache read and the cache written together, beside the cache's", () => {
    const usage = { input_tokens: 4, cache_read_input_tokens: 44000, cache_creation_input_tokens: 2096, output_tokens: 390 };
    const [segment] = segmentsOf([...request("t1", [ask]), ...replied("t1", { usage })]);
    expect(titleOf(1, segment!.formatted, true, { exchange: false, tool: false })).toContain("in 46.1k cache 44.0k written 2.1k out 390");
  });
});

describe("partedOf", () => {
  it("is the steps that stand after what another step stands after, and no step that alone follows one", () => {
    const answer = { role: "assistant", content: [{ type: "text", text: "Read." }] };
    const again = { role: "user", content: [{ type: "text", text: "Again." }] };
    const other = { role: "user", content: [{ type: "text", text: "Another way." }] };
    // The second and the third each resend the first and go on their own way; the fourth follows the third alone.
    const { forks } = createHistory()(
      createFormatter()(exchanges([...request("t1", [ask]), ...request("t2", [ask, answer, again]), ...request("t3", [ask, answer, other]), ...request("t4", [ask, answer, other, answer, again])])),
    );
    expect([...partedOf(forks)]).toEqual([2, 3]);
  });
});
