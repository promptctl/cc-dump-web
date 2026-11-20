import { describe, expect, it } from "vitest";
import { isTraceId, mintTraceId, parseTraceId } from "./trace.ts";

describe("trace ids", () => {
  it("mints W3C Trace Context's: 16 random bytes as lowercase hex, a new one each time", () => {
    const [one, two] = [mintTraceId(), mintTraceId()];
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(one).not.toBe(two);
  });

  it("takes a word of letters, digits, '-' and '_'", () => {
    expect(["t1", "4bf92f3577b34da6a3ce929d0e0e4736", "A-b_9"].map(parseTraceId)).toEqual(["t1", "4bf92f3577b34da6a3ce929d0e0e4736", "A-b_9"]);
  });

  it.each([[""], ["a/b"], ["thread:T"], ["a.b"], ["a b"], [7], [null]])("refuses %j, naming the shape", (value) => {
    expect(isTraceId(value)).toBe(false);
    expect(() => parseTraceId(value)).toThrow("is not a word: one or more letters, digits, '-' or '_'");
  });
});
