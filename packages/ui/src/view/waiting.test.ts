import { describe, expect, it } from "vitest";
import { waitingLine } from "./waiting.ts";

const row = { at: "row", key: "t1", offset: 0 } as const;
const place = { at: "waiting", on: "place" } as const;
const match = { at: "waiting", on: "match" } as const;

describe("the line under the rows", () => {
  it("says nothing while no move waits", () => {
    expect(waitingLine(row, row)).toBe("");
    expect(waitingLine({ at: "view" }, { at: "view" })).toBe("");
  });

  it("names the place and the moves from it while the place waits, the search's steps among them when the search counts from it", () => {
    expect(waitingLine(place, { at: "match", match: { key: "t1", at: "name", start: 0 } })).toBe("Your place is not read yet, so these wait for it ([, ], Alt+N, Alt+P)");
    expect(waitingLine(place, place)).toBe("Your place is not read yet, so these wait for it ([, ], Alt+N, Alt+P, n, N, Enter, Shift+Enter)");
  });

  it("names the match and the search's steps while the match waits, and both while both wait", () => {
    expect(waitingLine(row, match)).toBe("The match you were at is not read yet, so these wait for it (n, N, Enter, Shift+Enter)");
    expect(waitingLine(place, match)).toBe(
      "Your place is not read yet, so these wait for it ([, ], Alt+N, Alt+P). The match you were at is not read yet, so these wait for it (n, N, Enter, Shift+Enter)",
    );
  });
});
