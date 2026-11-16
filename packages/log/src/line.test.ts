import { describe, expect, it } from "vitest";
import { levelOf, parseLogLine } from "./line.ts";

const line = (event: Record<string, unknown>) =>
  JSON.stringify({ run: "r", seq: 3, event: { service: "proxy", event: "request", trace_id: "t", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 2, ...event } });

describe("parseLogLine", () => {
  it("reads a failed event with its error, and every other field as a fact", () => {
    expect(parseLogLine(line({ outcome: "error", error: "connect ECONNREFUSED", status: 502 }))).toEqual({
      run: "r",
      seq: 3,
      event: { service: "proxy", event: "request", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 2, outcome: "error", error: "connect ECONNREFUSED", facts: { trace_id: "t", status: 502 } },
    });
  });

  it("refuses a line whose outcome is no outcome, or a failure with no error", () => {
    expect(() => parseLogLine(line({ outcome: "fine" }))).toThrow("log line: event: outcome is not one of ok, aborted, stopped, error");
    expect(() => parseLogLine(line({ outcome: "error" }))).toThrow("log line: event: error is not a string");
  });
});

describe("levelOf", () => {
  it("is error for work that failed, warn for work cut short, info for work that ended as it should", () => {
    expect((["error", "aborted", "stopped", "ok"] as const).map(levelOf)).toEqual(["error", "warn", "warn", "info"]);
  });
});
