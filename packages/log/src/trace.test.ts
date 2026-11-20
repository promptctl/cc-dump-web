import { describe, expect, it } from "vitest";
import { isTraceId, mintTraceId, parseTraceId, traceIdShape } from "./trace.ts";

describe("a trace id", () => {
  it("is minted as 16 random bytes in lowercase hex, a new one each time", () => {
    const [one, two] = [mintTraceId(), mintTraceId()];
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(one).not.toBe(two);
  });

  it.each(["4bf92f3577b34da6a3ce929d0e0e4736", "t1", "A-b_9"])("is a word, as %s is", (value) => {
    expect(parseTraceId(value)).toBe(value);
  });

  // Each holds what a row key is cut at, or is no key's start.
  it.each(["", "a/b", "thread:T", "a.b", "a b", 7, null])("is refused for %j, naming its shape", (value) => {
    expect(isTraceId(value)).toBe(false);
    expect(() => parseTraceId(value)).toThrow(`${JSON.stringify(value)} is not ${traceIdShape}`);
  });
});
