import { describe, expect, it } from "vitest";
import { injectedFrom } from "./injected.ts";
import type { Position } from "./position.ts";
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
const indexOf = (listed: Row[]) => (key: string) => {
  const index = listed.findIndex((row) => row.key === key);
  return index === -1 ? undefined : index;
};
const from = (position: Position, direction: "next" | "previous", listed = rows) => injectedFrom(listed, indexOf(listed), position, direction);
const at = (key: string, offset = 0): Position => ({ at: "row", key, offset });

describe("the injected blocks", () => {
  it("goes to the first one listed after the position's row, and the last before it", () => {
    expect(from(at("a"), "next")).toBe("b");
    expect(from(at("c", 40), "next")).toBe("d");
    expect(from(at("c"), "previous")).toBe("b");
    expect(from(at("f"), "previous")).toBe("e");
  });

  it("goes on from an injected block the position is at, so a move after a move is the one after", () => {
    expect(from(at("b"), "next")).toBe("d");
    expect(from(at("d"), "next")).toBe("e");
    expect(from(at("e"), "previous")).toBe("d");
  });

  it("goes back to the start of an injected block the position is some way into", () => {
    expect(from(at("d", 40), "previous")).toBe("d");
    expect(from(at("d", 40), "next")).toBe("e");
  });

  it("counts a position in a row not listed from the end of the row listed before it", () => {
    // `d/hidden` is not listed: `d` stands for it, and the view is at d's end.
    expect(from(at("d/hidden"), "previous")).toBe("d");
    expect(from(at("d/hidden"), "next")).toBe("e");
  });

  it("goes around the ends", () => {
    expect(from(at("e"), "next")).toBe("b");
    expect(from(at("f"), "next")).toBe("b");
    expect(from(at("b"), "previous")).toBe("e");
    expect(from(at("a"), "previous")).toBe("e");
  });

  it("counts from before every row at the start, and from after them at the end", () => {
    expect(from({ at: "start" }, "next")).toBe("b");
    expect(from({ at: "start" }, "previous")).toBe("e");
    expect(from({ at: "end" }, "previous")).toBe("e");
    expect(from({ at: "end" }, "next")).toBe("b");
  });

  it("counts from the row a position inside it is nearest", () => {
    expect(from(at("c/body"), "next")).toBe("d");
  });

  it("is not taken from either end in place of a position whose row has not arrived, as after a reload", () => {
    expect([from(at("z"), "next"), from(at("z/body", 40), "previous")]).toEqual([{ unread: "z" }, { unread: "z/body" }]);
  });

  it("goes nowhere when no injected block is listed", () => {
    const said = [block("a", false), block("c", false)];
    expect(from(at("a"), "next", said)).toBeUndefined();
    expect(from({ at: "end" }, "previous", said)).toBeUndefined();
    expect(from({ at: "start" }, "next", [])).toBeUndefined();
  });
});
