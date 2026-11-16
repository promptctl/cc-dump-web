import { describe, expect, it } from "vitest";
import { ago } from "./status.ts";

describe("ago", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const before = (ms: number) => ago(now - ms, now);

  it("reads a time as long ago as it was, in the largest whole unit under the next", () => {
    expect([before(0), before(999), before(1000), before(59_999), before(60_000), before(3_599_999), before(3_600_000), before(86_399_999), before(86_400_000 * 3)]).toEqual([
      "now",
      "now",
      "1s ago",
      "59s ago",
      "1m ago",
      "59m ago",
      "1h ago",
      "23h ago",
      "3d ago",
    ]);
  });

  it("reads a time ahead of now as now", () => {
    expect(before(-5000)).toBe("now");
  });
});
