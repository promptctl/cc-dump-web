import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { forkMove, injectedMove, matchGone, matchMove, waitingOf, type Column } from "./moves.ts";
import type { Position } from "./position.ts";
import type { ForkRow, Keys, Row } from "./rows.ts";
import { address, createSearch, type Match } from "./search.ts";
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
      block: { key, category: "user", name: "text", parts: [{ kind: "text", form: "verbatim", text: said }], ...(injected ? { injected: true as const } : {}) },
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
// among the rows one nothing will.
const column: Column = { layout: { rows, keys, every: { keys } }, unread: (key) => key.startsWith("later") };
const pattern = /needle/g;
const found = createSearch()(rows, pattern);

const at = (key: string): Position => ({ at: "row", key, offset: 0 });
const match = (key: string): Match => ({ key, at: address.part(0), start: 4 });
const [listed, unread, gone] = [at("a"), at("later/x"), at("z/x")];

describe("a move from the reader's place", () => {
  it("counts from a place among the rows", () => {
    expect(forkMove(column, listed)?.key).toBe("a/fork");
    expect(injectedMove(column, listed, "next")).toBe("a/reminder");
    expect(matchMove(column, found, undefined, listed, "next", pattern)?.match.key).toBe("a/said");
  });

  it("is none from a place not read yet, which the line says", () => {
    expect([forkMove(column, unread), injectedMove(column, unread, "next"), matchMove(column, found, undefined, unread, "next", pattern)]).toEqual([undefined, undefined, undefined]);
    expect(waitingOf(column, unread, undefined)).toBe("place");
  });

  it("is none from a place nothing will bring, which the line does not say: the scroll step replaces it", () => {
    expect([forkMove(column, gone), injectedMove(column, gone, "previous"), matchMove(column, found, undefined, gone, "previous", pattern)]).toEqual([undefined, undefined, undefined]);
    expect(waitingOf(column, gone, undefined)).toBeUndefined();
  });

  it("goes on from a current match among the rows, and is none from one not read yet, which the line says, or one gone", () => {
    expect(matchMove(column, found, match("a/said"), listed, "next", pattern)?.match.key).toBe("a/reminder");
    expect(matchMove(column, found, match("later/said"), listed, "next", pattern)).toBeUndefined();
    expect(waitingOf(column, listed, match("later/said"))).toBe("match");
    expect(matchMove(column, found, match("z/said"), listed, "next", pattern)).toBeUndefined();
    expect(waitingOf(column, listed, match("z/said"))).toBeUndefined();
  });

  it("says the place first when both it and the current match are not read yet", () => {
    expect(waitingOf(column, unread, match("later/said"))).toBe("place");
  });

  it("finds a current match gone only when nothing will bring it", () => {
    expect([match("z/said"), match("later/said"), match("a/said"), undefined].map((current) => matchGone(column, current))).toEqual([true, false, false, false]);
  });
});

describe("the line under the rows", () => {
  // What the line says, fed as the conversation feeds it, from the store's place and current match.
  const says = (position: Position, current?: Match) => renderToStaticMarkup(<WaitingLine waiting={waitingOf(column, position, current)} />);

  it("says which of the place and the current match is not read yet, as a status", () => {
    expect(says(unread)).toMatch(/<p role="status"[^>]*>Your place is not read yet<\/p>/);
    expect(says(listed, match("later/said"))).toMatch(/>The current match is not read yet</);
  });

  it("is empty while nothing holds the moves, and for a place nothing will bring", () => {
    expect(says(listed, match("a/said"))).toMatch(/<p role="status"[^>]*><\/p>/);
    expect(says(gone)).toMatch(/<p role="status"[^>]*><\/p>/);
  });
});
