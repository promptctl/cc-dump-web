import { describe, expect, it } from "vitest";
import { lineLevel, levelOf, parseLogLine } from "./line.ts";

const event = (fields: Record<string, unknown>) => JSON.stringify({ service: "proxy", event: "request", trace_id: "t", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 2, ...fields });

describe("parseLogLine", () => {
  it("reads the line its id places, a failed event with its error and trace and every other field as a fact", () => {
    expect(parseLogLine(event({ outcome: "error", error: "connect ECONNREFUSED", status: 502 }), "ab12:3")).toEqual({
      run: "ab12",
      seq: 3,
      event: { service: "proxy", event: "request", trace_id: "t", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 2, outcome: "error", error: "connect ECONNREFUSED", facts: { status: 502 } },
    });
  });

  it("keeps a line whose event does not parse in its place, unread, saying why", () => {
    expect(parseLogLine(event({ outcome: "fine" }), "ab12:4")).toEqual({ run: "ab12", seq: 4, unread: event({ outcome: "fine" }), error: "log line: outcome: is not one of ok, aborted, stopped, error" });
    expect(parseLogLine(event({ outcome: "error" }), "ab12:5")).toMatchObject({ seq: 5, error: "log line: error: is missing" });
    expect(parseLogLine(event({ outcome: "ok", trace_id: undefined }), "ab12:6")).toMatchObject({ seq: 6, error: expect.stringContaining("log line: trace_id") });
    expect(lineLevel(parseLogLine("{", "ab12:7"))).toBe("error");
  });

  it("refuses a message whose id is no line's", () => {
    expect(() => parseLogLine(event({ outcome: "ok" }), "")).toThrow('log line: id "" is not run:seq');
    expect(() => parseLogLine(event({ outcome: "ok" }), "ab12:x")).toThrow("is not run:seq");
  });
});

describe("levelOf", () => {
  it("is error for work that failed, warn for work its server stopped, info for work that ended or its client left", () => {
    expect((["error", "stopped", "aborted", "ok"] as const).map(levelOf)).toEqual(["error", "warn", "info", "info"]);
  });
});
