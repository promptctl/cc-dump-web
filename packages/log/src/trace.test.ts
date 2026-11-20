import { describe, expect, it } from "vitest";
import { startSpan } from "./index.ts";
import { isTraceId, mintTraceId } from "./trace.ts";

describe("trace ids", () => {
  it("mints each new span's trace id in the one shape the parse reads, a new one each time", () => {
    const minted = [mintTraceId(), mintTraceId(), startSpan().trace_id];
    expect(minted.map(isTraceId)).toEqual([true, true, true]);
    expect(new Set(minted).size).toBe(3);
  });
});
