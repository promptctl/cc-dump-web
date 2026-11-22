import { readWith } from "../testing.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { forkMove, injectedMove, matchMove, matchStanding, waitingOf, type ColumnState } from "./moves.ts";
import type { Position } from "./position.ts";
import type { ForkRow, Keys, Row } from "./rows.ts";
import { address, createSearch, type Current, type Match } from "./search.ts";
import { WaitingLine } from "./WaitingLine.tsx";

const standing = { depth: 0, dimmed: false };
const line = (key: string): Row => ({ kind: "group", key, title: "tools", change: "same", ...standing });
const fork: ForkRow = { kind: "fork", key: "a/fork", change: "same", siblings: [{ step: 2, preview: "" }, { step: 3, preview: "" }], shown: 2, ...standing };
// A block's row at `key` saying `said`, which the harness injected when `injected`.
const block = (key: string, said: string, injected = false): Row => ({
  kind: "block",
  key,
  change: "same",
  versions: [
    {
      step: 1,
      block: { key, category: "user", name: "text", parts: [{ id: "text", kind: "text", form: "verbatim", text: said }], ...(injected ? { injected: true as const } : {}) },
      reply: false,
      rewrote: undefined,
      previous: undefined,
    },
  ],
  at: 0,
  set: undefined,
  ...standing,
});
// A line, a fork, a block saying the needle, an injected one saying it too.
const rows = [line("a"), fork, block("a/said", "the needle"), block("a/reminder", "a needle", true)];
const keys: Keys = {
  at: (index) => rows[index]!.key,
  indexOf: (key) => {
    const index = rows.findIndex((row) => row.key === key);
    return index === -1 ? undefined : index;
  },
};
// The column, every row listed, in which a key starting `later` is one the read can still bring, and any other not
// among the rows one nothing will; and the same column after the read failed.
const column: ColumnState = { rows, keys: { ...keys, measuredBy: keys.at }, every: { rows, keys }, moment: readWith((key) => (key.startsWith("later") ? "reading" : undefined)) };
const failed: ColumnState = { ...column, moment: readWith((key) => (key.startsWith("later") ? "failed" : undefined)) };
const pattern = /needle/g;
const found = createSearch()(rows, pattern);

const at = (key: string): Position => ({ at: "row", key, offset: 0 });
const match = (key: string): Match => ({ key, at: address.part({ id: "text" }), start: 4 });
const [listed, pending, gone] = [at("a"), at("later/x"), at("z/x")];

describe("a move from the reader's place", () => {
  it("counts from a place among the rows", () => {
    expect(forkMove(column, listed)?.key).toBe("a/fork");
    expect(injectedMove(column, listed, "next")).toBe("a/reminder");
    expect(matchMove(column, found, undefined, listed, "next", pattern)?.match.key).toBe("a/said");
  });

  it("is none from a place not read yet, which the line says, with what can still bring it", () => {
    expect([forkMove(column, pending), injectedMove(column, pending, "next"), matchMove(column, found, undefined, pending, "next", pattern)]).toEqual([undefined, undefined, undefined]);
    expect(waitingOf(column, pending, undefined)).toEqual({ held: "place", read: "reading" });
    expect(waitingOf(failed, pending, undefined)).toEqual({ held: "place", read: "failed" });
  });

  it("is none from any place while the moment's step is not read, since the column shown is another's", () => {
    const held: ColumnState = { ...column, moment: { at: "pending", read: "reading" } };
    expect([forkMove(held, listed), injectedMove(held, listed, "next"), matchMove(held, found, undefined, listed, "next", pattern), matchMove(held, found, match("a/said"), listed, "next", pattern)]).toEqual([undefined, undefined, undefined, undefined]);
    expect(waitingOf(held, listed, undefined)).toEqual({ held: "place", read: "reading" });
  });

  it("steps the search from a current match among the rows, though the place is not read yet", () => {
    expect(matchMove(column, found, match("a/said"), pending, "next", pattern)?.match.key).toBe("a/reminder");
  });

  it("is none from a place nothing will bring, which the line does not say: the scroll step replaces it", () => {
    expect([forkMove(column, gone), injectedMove(column, gone, "previous"), matchMove(column, found, undefined, gone, "previous", pattern)]).toEqual([undefined, undefined, undefined]);
    expect(waitingOf(column, gone, undefined)).toBeUndefined();
  });

  it("goes on from a current match among the rows, and is none from one not read yet, which the line says, or one gone", () => {
    expect(matchMove(column, found, match("a/said"), listed, "next", pattern)?.match.key).toBe("a/reminder");
    expect(matchMove(column, found, match("later/said"), listed, "next", pattern)).toBeUndefined();
    expect(waitingOf(column, listed, match("later/said"))).toEqual({ held: "match", read: "reading" });
    expect(matchMove(column, found, match("z/said"), listed, "next", pattern)).toBeUndefined();
    expect(waitingOf(column, listed, match("z/said"))).toBeUndefined();
  });

  it("says the place first when both it and the current match are not read yet", () => {
    expect(waitingOf(column, pending, match("later/said"))).toEqual({ held: "place", read: "reading" });
  });

  it("judges a current match gone when nothing will bring it or its pattern is another, standing while it is not read yet or its text is as it was, and carried as its text changes", () => {
    // The needle in the text `text`, of the block `key`.
    const current = (key: string, text = "the needle", at = address.part({ id: "text" })): Current => ({ key, at, start: text.indexOf("needle"), end: text.indexOf("needle") + 6, pattern: String(pattern) });
    // The column as it was when the block `a/said` said only "needle".
    const before: ColumnState = { ...column, every: { rows: rows.map((row) => (row.key === "a/said" ? block("a/said", "needle") : row)), keys } };
    expect(matchStanding(column, column, current("z/said"), pattern)).toEqual({ at: "gone", why: "read_ended" });
    expect(matchStanding(column, column, current("a/said"), /needle/giu)).toEqual({ at: "gone", why: "pattern_changed" });
    expect(matchStanding(column, column, current("later/said"), pattern)).toEqual({ at: "standing" });
    expect(matchStanding(column, column, current("a/said"), pattern)).toEqual({ at: "standing" });
    expect(matchStanding(before, column, current("a/said", "needle"), pattern)).toEqual({ at: "carried", to: current("a/said") });
    expect(matchStanding(column, column, current("a/said", "the needle", address.part({ id: "other" })), pattern)).toEqual({ at: "gone", why: "text_gone" });
  });
});

describe("the line under the rows", () => {
  // What the line says, fed as the conversation feeds it, from the store's place and current match.
  const says = (position: Position, current?: Match, read = column) => renderToStaticMarkup(<WaitingLine waiting={waitingOf(read, position, current)} />);

  it("says which of the place and the current match is not read yet, as a status", () => {
    expect(says(pending)).toMatch(/<p role="status"[^>]*>Your place is not read yet<\/p>/);
    expect(says(listed, match("later/said"))).toMatch(/>The current match is not read yet</);
  });

  it("says, after the read failed, that it failed before the row", () => {
    expect(says(pending, undefined, failed)).toMatch(/>The read failed before your place</);
    expect(says(listed, match("later/said"), failed)).toMatch(/>The read failed before the current match</);
  });

  it("says the place is not read yet while the moment's step is not, wherever the place is", () => {
    expect(says(listed, undefined, { ...column, moment: { at: "pending", read: "reading" } })).toMatch(/>Your place is not read yet</);
  });

  it("is empty while nothing holds the moves, and for a place nothing will bring", () => {
    expect(says(listed, match("a/said"))).toMatch(/<p role="status"[^>]*><\/p>/);
    expect(says(gone)).toMatch(/<p role="status"[^>]*><\/p>/);
  });
});
