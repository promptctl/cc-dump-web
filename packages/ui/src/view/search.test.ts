import { exchanges } from "../testing.ts";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { categories, type Block, type Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import { parseSettings, type SearchOptions, type Visibility } from "../settings.ts";
import { regionKey } from "./regions.ts";
import { render } from "./rendering.ts";
import { request as fixtureRequest } from "../../test/fixtures.ts";
import { createHistory } from "./history.ts";
import { blockOf, createLayout, type BlockRow, type Keys, type Layout, type Row } from "./rows.ts";
import { matchMove } from "./moves.ts";
import type { Position } from "./position.ts";
import { address, createSearch, find, ordinal, partKey, patternOf, rangesIn, shownTexts, whole, type Direction, type Found, type Match, type Searched } from "./search.ts";

// A request whose header holds what a search can find.
const request = (trace_id: string, body: unknown): RecordedEvent[] => fixtureRequest(trace_id, body, { headers: [["x-probe", "needle in a header"]] });
const lines = (count: number, at: number, line: string) => Array.from({ length: count }, (_, index) => (index === at ? line : `filler ${index}`));
// A tool result holding a tagged section of 16 lines, which holds a 14-line code block with the needle on its line 5.
const section = ["<notes>", ...lines(1, -1, ""), "```", ...lines(12, 4, "the NEEDLE is here"), "```", "</notes>"].join("\n");
const body = {
  model: "m",
  messages: [
    { role: "user", content: "Look for the needle." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Needle", input: { query: "needle" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `Found it:\n${section}\nDone.` }] },
  ],
};
// b's first message is its own, so it is a thread of its own, every row of it b's.
const other = { ...body, messages: [{ role: "user", content: "Look for the needle!" }, ...body.messages.slice(1)] };
const { search: defaults } = parseSettings(undefined);
// Every category listed.
const shown = Object.fromEntries(categories.map((category) => [category, "compact"])) as Record<Category, Visibility>;
const layOut = (visibility: Record<Category, Visibility> = shown, current?: string): Layout =>
  createLayout(visibility)(createHistory()(createFormatter()(exchanges([...request("a", body), ...request("b", other)]))), 2, current, {});
// A query read under the default options, with those given changed.
const read = (query: string, options: Partial<SearchOptions> = {}) => patternOf(query, { ...defaults, ...options });
const { pattern } = read("needle");
// The view at its start, where a step with no current match goes on from.
const top = { at: "start" } as const;
// A step of the search as the view takes it (moves.ts), in a column listing every row `found` was made from, keyed
// `keys`, none of them still to be read.
const adjacent = (found: Found, current: Match | undefined, position: Position, direction: Direction, pattern: RegExp, keys: Keys) => {
  const rows = [...found.rows];
  return matchMove({ rows, keys: { ...keys, measuredBy: keys.at }, every: { rows, keys }, moment: { at: "read", pending: () => undefined } }, found, current, position, direction, pattern);
};
// The keys of `rows`, in order.
const keysOf = (rows: readonly Row[]): Keys => ({ at: (index) => rows[index]!.key, indexOf: (key) => { const index = rows.findIndex((row) => row.key === key); return index === -1 ? undefined : index; } });
// A row the step shown added, of `block` alone; or, `gone`, one it took away, which shows the block it was.
const added = (block: Block, gone = false): BlockRow => {
  const shown = { ...block, key: "k" };
  const versions: BlockRow["versions"] = [{ step: 1, block: shown, reply: false, rewrote: undefined, previous: undefined }, ...(gone ? [{ step: 2, block: undefined, was: shown, previous: 0 }] : [])];
  return { kind: "block", key: "k", change: gone ? "removed" : "added", versions, at: versions.length - 1, set: undefined, depth: 0, dimmed: false };
};

describe("search", () => {
  it("names each text a block shows by its address, and where it shows", () => {
    expect(
      shownTexts(
        added({
          category: "tools",
          name: "tool_use: X",
          parts: [
            { kind: "text", form: "verbatim", text: "t" },
            { kind: "json", value: { a: 1 } },
            { kind: "fields", fields: [["id", "1"], ["thinking", [["type", "adaptive"]]]] },
            { kind: "media", of: "image", source: { type: "url", url: "u" } },
          ],
        }),
      ),
    ).toEqual([
      { at: address.name, searched: whole("tool_use: X"), in: "line" },
      { at: "0", searched: render("t", "verbatim"), in: "regions" },
      { at: "1", searched: whole('{\n  "a": 1\n}'), in: "content" },
      { at: "2/0/name", searched: whole("id"), in: "content" },
      { at: "2/0/value", searched: whole("1"), in: "content" },
      // A field that holds fields is its name alone, and the fields it holds are lines of their own after it.
      { at: "2/1/name", searched: whole("thinking"), in: "content" },
      { at: "2/2/name", searched: whole("type"), in: "content" },
      { at: "2/2/value", searched: whole("adaptive"), in: "content" },
    ]);
  });

  it("reads a query as a regular expression, in any case, and the empty query as matching nowhere", () => {
    expect(defaults).toEqual({ caseSensitive: false, wholeWord: false, regex: true });
    expect(find(read("a.b").pattern, whole("A.B axb a.b"))).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(find(read("ab|cd").pattern, whole("xcd AB"))).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
    expect(find(read("").pattern, whole("anything"))).toEqual([]);
    expect(read("").error).toBeUndefined();
  });

  it("reads a query as the characters typed when regular expression is off, and as typed in case when case is on", () => {
    expect(find(read("a.b", { regex: false }).pattern, whole("A.B axb a.b"))).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(find(read("a.b", { regex: false, caseSensitive: true }).pattern, whole("A.B axb a.b"))).toEqual([{ start: 8, end: 11 }]);
    expect(find(read("(", { regex: false }).pattern, whole("f(x)"))).toEqual([{ start: 1, end: 2 }]);
  });

  it("matches a whole word only, with Unicode letters and the underscore making words, and an alternation whole", () => {
    const starts = (query: string, text: string, options: Partial<SearchOptions> = {}) =>
      find(read(query, { wholeWord: true, ...options }).pattern, whole(text)).map(({ start }) => start);
    expect(starts("cat", "cat concat cats caféx cat_ cat.")).toEqual([0, 27]);
    expect(starts("caf", "café caf")).toEqual([5]);
    expect(starts("é", "café é")).toEqual([5]);
    expect(starts("cat|dog", "dogs cat bobdog dog")).toEqual([5, 16]);
    expect(starts("a.b", "a.b axb", { regex: false })).toEqual([0]);
  });

  it("reports a query that is not a valid expression, which matches nothing, and reads it as characters when regular expression is off", () => {
    for (const options of [{}, { wholeWord: true }, { caseSensitive: true }]) {
      for (const query of ["(", "[a-", "a)(b", "*", "\\"]) {
        const { pattern, error } = read(query, options);
        expect(error, `${query} ${JSON.stringify(options)}`).toEqual(expect.any(String));
        expect(find(pattern, whole(`${query} anything`))).toEqual([]);
      }
    }
    expect(read("(", { regex: false }).error).toBeUndefined();
    expect(createSearch()(layOut().every.rows, read("(").pattern).count).toBe(0);
  });

  it("reads a diff's lines in order, each a passage, so a match is found within a line and never across two", () => {
    const [, shown] = shownTexts(added({ category: "tools", name: "tool_use: Edit", parts: [{ kind: "diff", before: "keep\nold end", after: "keep\nnew" }] }));
    expect(shown).toMatchObject({ at: "0", searched: { text: "keep\nold end\nnew", passages: [{ start: 0, end: 4 }, { start: 5, end: 12 }, { start: 13, end: 16 }] }, in: "content" });
    expect(find(read("end\\snew").pattern, shown!.searched as Searched)).toEqual([]);
    expect(find(read("new").pattern, shown!.searched as Searched)).toEqual([{ start: 13, end: 16 }]);
  });

  it("searches a block a step took away as the block it was, which its row shows", () => {
    const row = added({ category: "system", name: "system", parts: [{ kind: "text", form: "markdown", text: "the needle" }] }, true);
    expect(createSearch()([row], pattern).count).toBe(1);
  });

  it("finds no match where an expression matches nothing", () => {
    expect(find(read("x*").pattern, whole("axxb"))).toEqual([{ start: 1, end: 3 }]);
    expect(find(read("^").pattern, whole("line\nline"))).toEqual([]);
  });

  it("counts the matches in every block, hidden categories' included, in names, text, JSON and fields", () => {
    const { every } = layOut();
    const found = createSearch()(every.rows, pattern);
    // Each exchange: the header's value, the user's text, the tool call's name and its input's JSON, the tool result.
    expect(found.count).toBe(10);
    expect(found.blocks.map(({ count }) => count)).toEqual([1, 1, 2, 1, 1, 1, 2, 1]);
    const hidden = layOut({ ...shown, tools: "hidden", parameters: "hidden", usage: "hidden", http: "hidden" });
    expect(createSearch()(hidden.every.rows, pattern).count).toBe(10);
    expect(hidden.rows.length).toBeLessThan(every.rows.length);
  });

  it("steps through the matches in order and wraps at either end, counting which is current", () => {
    const { every } = layOut();
    const keys = every.keys;
    const found = createSearch()(every.rows, pattern);
    const seen: Match[] = [];
    let current: Match | undefined;
    for (let index = 0; index < 11; index++) {
      current = adjacent(found, current, top, "next", pattern, keys)!.match;
      seen.push(current);
    }
    expect(seen.slice(0, 10).map((match) => ordinal(found, match, pattern))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen[10]).toEqual(seen[0]);
    expect(adjacent(found, seen[0], top, "previous", pattern, keys)!.match).toEqual(seen[9]);
    expect(adjacent(found, undefined, top, "previous", pattern, keys)!.match).toEqual(seen[9]);
    expect(seen[2]).toEqual({ key: "thread:a/message.1/content.0", at: address.name, start: 10 });
    const absent = read("absent").pattern;
    expect(adjacent(createSearch()(every.rows, absent), undefined, top, "next", absent, keys)).toBeUndefined();
  });

  it("steps through the same matches in the same order whichever categories are hidden, and counts them the same", () => {
    const stepsOf = (visibility: Record<Category, Visibility>) => {
      const { every } = layOut(visibility);
      const found = createSearch()(every.rows, pattern);
      const matches: Match[] = [];
      for (let index = 0; index < found.count; index++) matches.push(adjacent(found, matches.at(-1), top, "next", pattern, every.keys)!.match);
      return { count: found.count, matches, ordinals: matches.map((match) => ordinal(found, match, pattern)) };
    };
    const hidden = stepsOf({ ...shown, tools: "hidden", parameters: "hidden", usage: "hidden", http: "hidden" });
    expect(hidden).toEqual(stepsOf(shown));
    expect(hidden.ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("steps on from a current match in a hidden category to the match before and after it in the conversation", () => {
    const { every } = layOut({ ...shown, tools: "hidden" });
    const found = createSearch()(every.rows, pattern);
    const toolResult = adjacent(found, { key: "thread:a/message.2/content.0", at: address.part(0), start: -1 }, top, "next", pattern, every.keys)!.match;
    // After exchange a's tool result: exchange b's header; before it: the JSON of exchange a's tool call, also hidden.
    expect(adjacent(found, toolResult, top, "next", pattern, every.keys)!.match.key).toBe("b/request/http");
    expect(adjacent(found, toolResult, top, "previous", pattern, every.keys)!.match).toMatchObject({ key: "thread:a/message.1/content.0", at: address.part(0) });
  });

  it("lists a hidden category's block while it holds the current match, and no longer once a step moves on from it", () => {
    const hidden = { ...shown, tools: "hidden", parameters: "hidden", usage: "hidden", http: "hidden" } as const;
    const { every } = layOut(hidden);
    const found = createSearch()(every.rows, pattern);
    const hiddenBlocksListed = (current?: string) =>
      layOut(hidden, current)
        .rows.filter((row) => row.kind === "block" && hidden[blockOf(row).category] === "hidden")
        .map(({ key }) => key);
    expect(hiddenBlocksListed()).toEqual([]);
    const categoryOf = (key: string) => blockOf(every.rows.find((row) => row.key === key) as BlockRow).category;
    let current: Match | undefined;
    const inHidden: string[] = [];
    for (let index = 0; index < found.count; index++) {
      const step = adjacent(found, current, top, "next", pattern, every.keys)!;
      current = step.match;
      const isHidden = hidden[categoryOf(current.key)] === "hidden";
      // The step's block is the only one of a hidden category listed, so the one before it is no longer.
      expect(hiddenBlocksListed(current.key)).toEqual(isHidden ? [current.key] : []);
      if (isHidden) inHidden.push(current.key);
    }
    expect(new Set(inHidden)).toEqual(new Set(["a/request/http", "thread:a/message.1/content.0", "thread:a/message.2/content.0", "b/request/http", "thread:b/message.1/content.0", "thread:b/message.2/content.0"]));
  });

  it("steps on from a current match whose block the formatter replaced, from the row it was inside, as the view does", () => {
    const { rows, keys } = layOut().every;
    const found = createSearch()(rows, pattern);
    const replaced = { key: "thread:a/message.1/content.0/so-far", at: address.part(0), start: 0 };
    expect(adjacent(found, replaced, top, "next", pattern, keys)!.match.key).toBe("thread:a/message.2/content.0");
    expect(adjacent(found, replaced, top, "previous", pattern, keys)!.match).toMatchObject({ key: "thread:a/message.1/content.0", at: address.part(0) });
    // One whose exchange is not among the rows at all, with nothing more to read, is gone: no step counts from it.
    expect(adjacent(found, { ...replaced, key: "z/request/http" }, top, "next", pattern, keys)).toBeUndefined();
  });

  it("steps with no current match from the view's position: its top row's matches going on, those above it going back", () => {
    const { rows, keys } = layOut().every;
    const found = createSearch()(rows, pattern);
    const at = { at: "row", key: "thread:b/message.0/content.0", offset: 40 } as const;
    expect(adjacent(found, undefined, at, "next", pattern, keys)!.match.key).toBe("thread:b/message.0/content.0");
    expect(adjacent(found, undefined, at, "previous", pattern, keys)!.match.key).toBe("b/request/http");
    // At the end, going on wraps to the first match.
    expect(adjacent(found, undefined, { at: "end" }, "next", pattern, keys)!.match.key).toBe("a/request/http");
  });

  it("steps from the view's position counted among every row, so rows hidden above it move no step", () => {
    const hidden = layOut({ ...shown, http: "hidden", tools: "hidden" });
    const found = createSearch()(hidden.every.rows, pattern);
    // The column as the view holds it: its listed rows, fewer than every row, the hidden HTTP blocks among them.
    const column = { ...hidden, moment: { at: "read", pending: () => undefined } } as const;
    const at = { at: "row", key: "thread:b/message.0/content.0", offset: 40 } as const;
    expect(hidden.keys.indexOf(at.key)).not.toBe(hidden.every.keys.indexOf(at.key));
    expect(matchMove(column, found, undefined, at, "next", pattern)!.match.key).toBe("thread:b/message.0/content.0");
    expect(matchMove(column, found, undefined, at, "previous", pattern)!.match.key).toBe("b/request/http");
  });

  it("opens the block and every region holding a match, and nothing for a match on the block's line", () => {
    const { rows, keys } = layOut().every;
    const found = createSearch()(rows, pattern);
    const result = adjacent(found, { key: "thread:a/message.2/content.0", at: address.part(0), start: -1 }, top, "next", pattern, keys)!;
    const part = partKey("thread:a/message.2/content.0", address.part(0));
    expect(result).toEqual({
      match: { key: "thread:a/message.2/content.0", at: address.part(0), start: result.match.start },
      folds: ["thread:a/message.2/content.0", regionKey(part, 1), regionKey(part, 3)],
    });
    const name = adjacent(found, { key: "thread:a/message.1/content.0", at: address.name, start: -1 }, top, "next", pattern, keys)!;
    expect(name).toMatchObject({ match: { key: "thread:a/message.1/content.0" }, folds: [] });
  });

  it("opens the nests a match's block is inside, the innermost first", () => {
    const nest = (key: string, depth: number): Row => ({ kind: "nest", key, change: "same", level: { kind: "unread" }, prompt: "", count: 1, depth, dimmed: false });
    const inner = { ...added({ category: "assistant", name: "text", parts: [{ kind: "text", form: "verbatim", text: "the needle" }] }), depth: 2 };
    const nested = [nest("outer/nest", 0), nest("inner/nest", 1), inner];
    const found = createSearch()(nested, pattern);
    expect(adjacent(found, undefined, top, "next", pattern, keysOf(nested))!.folds).toEqual(["inner/nest", "outer/nest", "k"]);
  });

  it("opens the section of each heading over a match, and none for a match in a heading no section holds", () => {
    const row = added({ category: "assistant", name: "text", parts: [{ kind: "text", form: "markdown", text: "# Needle plan\n\n## Steps\n\nfind the needle\n" }] });
    const found = createSearch()([row], pattern);
    const part = partKey("k", address.part(0));
    const heading = adjacent(found, undefined, top, "next", pattern, keysOf([row]))!;
    expect(heading).toMatchObject({ match: { at: address.part(0), start: 0 }, folds: ["k"] });
    expect(adjacent(found, heading.match, top, "next", pattern, keysOf([row]))!.folds).toEqual(["k", regionKey(part, 0), regionKey(part, 2)]);
  });

  it("gives the matches holding any of a slice of a text", () => {
    const ranges = [
      { start: 2, end: 4 },
      { start: 8, end: 12 },
      { start: 20, end: 21 },
    ];
    expect(rangesIn(ranges, 0, 8)).toEqual([{ start: 2, end: 4 }]);
    expect(rangesIn(ranges, 8, 20)).toEqual([{ start: 8, end: 12 }]);
    expect(rangesIn(ranges, 4, 8)).toEqual([]);
    expect(rangesIn(ranges, 0, 30)).toEqual(ranges);
    // A match running from one leaf into the next is in both; an empty leaf holds no characters, so no match.
    expect(rangesIn(ranges, 10, 11)).toEqual([{ start: 8, end: 12 }]);
    expect(rangesIn(ranges, 3, 9)).toEqual([
      { start: 2, end: 4 },
      { start: 8, end: 12 },
    ]);
    expect(rangesIn(ranges, 10, 10)).toEqual([]);
  });

  it("finds in a Markdown text what a reader sees: no syntax, and a phrase across emphasis once", () => {
    const rendering = render("Say **hello** world, `code` too.\n", "markdown");
    expect(find(read("**").pattern, rendering)).toEqual([]);
    expect(find(read("`").pattern, rendering)).toEqual([]);
    expect(find(read("hello world").pattern, rendering)).toHaveLength(1);
    expect(find(read("code too").pattern, rendering)).toHaveLength(1);
  });
});
