import { describe, expect, it } from "vitest";
import { injectedFrom } from "./injected.ts";
import type { At } from "./position.ts";
import type { Row } from "./rows.ts";

// A block's row at `key`: what was said, or, `injected`, what the harness put into the message.
const block = (key: string, injected: boolean): Row => ({
  kind: "block",
  key,
  change: "same",
  versions: [
    {
      step: 1,
      block: { key, category: "user", name: injected ? "system reminder" : "text", parts: [{ kind: "text", form: "verbatim", text: key }], ...(injected ? { injected: true as const } : {}) },
      reply: false,
      rewrote: undefined,
      previous: undefined,
    },
  ],
  at: 0,
  set: undefined,
  depth: 0,
  dimmed: false,
});
// Said, injected, said, injected, injected, said.
const rows = [block("a", false), block("b", true), block("c", false), block("d", true), block("e", true), block("f", false)];
// The injected block from the place `at`, among `listed`.
const from = (at: At, direction: "next" | "previous", listed = rows) => injectedFrom(listed, at, direction);
// A place at the row at `index`, `offset` into it.
const row = (index: number, offset = 0): At => ({ at: "row", index, offset });

describe("the injected blocks", () => {
  it("goes to the first one listed after the place's row, and the last before it", () => {
    expect(from(row(0), "next")).toBe("b");
    expect(from(row(2, 40), "next")).toBe("d");
    expect(from(row(2), "previous")).toBe("b");
    expect(from(row(5), "previous")).toBe("e");
  });

  it("goes on from an injected block the place is at, so a move after a move is the one after", () => {
    expect(from(row(1), "next")).toBe("d");
    expect(from(row(3), "next")).toBe("e");
    expect(from(row(4), "previous")).toBe("d");
  });

  it("goes back to the start of an injected block the place is some way into", () => {
    expect(from(row(3, 40), "previous")).toBe("d");
    expect(from(row(3, 40), "next")).toBe("e");
  });

  it("counts a place at the end of a row standing in for its own from that row's end", () => {
    expect(from(row(3, Infinity), "previous")).toBe("d");
    expect(from(row(3, Infinity), "next")).toBe("e");
  });

  it("goes around the ends", () => {
    expect(from(row(4), "next")).toBe("b");
    expect(from(row(5), "next")).toBe("b");
    expect(from(row(1), "previous")).toBe("e");
    expect(from(row(0), "previous")).toBe("e");
  });

  it("counts from before every row at the start, and from after them at the end", () => {
    expect(from({ at: "start" }, "next")).toBe("b");
    expect(from({ at: "start" }, "previous")).toBe("e");
    expect(from({ at: "end" }, "previous")).toBe("e");
    expect(from({ at: "end" }, "next")).toBe("b");
  });

  it("goes nowhere when no injected block is listed", () => {
    const said = [block("a", false), block("c", false)];
    expect(from(row(0), "next", said)).toBeUndefined();
    expect(from({ at: "end" }, "previous", said)).toBeUndefined();
    expect(from({ at: "start" }, "next", [])).toBeUndefined();
  });
});
