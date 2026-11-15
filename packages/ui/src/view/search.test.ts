import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import type { Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import { parseSettings, type SearchOptions, type Visibility } from "../settings.ts";
import { regionKey } from "./regions.ts";
import { createHistory } from "./history.ts";
import { createLayout, type Layout } from "./rows.ts";
import { address, adjacent, createSearch, find, ordinal, partKey, patternOf, rangesIn, shownTexts, type Match } from "./search.ts";

const timestamp = "2026-11-13T08:00:00.000Z";
const request = (trace_id: string, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [["x-probe", "needle in a header"]] },
  { timestamp, trace_id, type: "request_body", base64: Buffer.from(JSON.stringify(body)).toString("base64") },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
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
const { visibility: shown, search: defaults } = parseSettings(undefined);
const layOut = (visibility: Record<Category, Visibility> = shown, revealed?: string): Layout =>
  createLayout(visibility, "show")(createHistory()(createFormatter()(exchanges([...request("a", body), ...request("b", other)]))), 2, revealed, {});
// A query read under the default options, with those given changed.
const read = (query: string, options: Partial<SearchOptions> = {}) => patternOf(query, { ...defaults, ...options });
const { pattern } = read("needle");
// The view at its start, where a step with no current match goes on from.
const top = { at: "start" } as const;

describe("search", () => {
  it("names each text a block shows by its address, and where it shows", () => {
    expect(
      shownTexts({
        category: "tools",
        name: "tool_use: X",
        parts: [
          { kind: "text", text: "t" },
          { kind: "json", value: { a: 1 } },
          { kind: "fields", fields: [["id", "1"]] },
          { kind: "media", of: "image", source: { type: "url", url: "u" } },
        ],
      }),
    ).toEqual([
      { at: address.name, text: "tool_use: X", in: "line" },
      { at: "0", text: "t", in: "regions" },
      { at: "1", text: '{\n  "a": 1\n}', in: "content" },
      { at: "2/0/name", text: "id", in: "content" },
      { at: "2/0/value", text: "1", in: "content" },
    ]);
  });

  it("reads a query as a regular expression, in any case, and the empty query as matching nowhere", () => {
    expect(defaults).toEqual({ caseSensitive: false, wholeWord: false, regex: true });
    expect(find(read("a.b").pattern, "A.B axb a.b")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(find(read("ab|cd").pattern, "xcd AB")).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
    expect(find(read("").pattern, "anything")).toEqual([]);
    expect(read("").error).toBeUndefined();
  });

  it("reads a query as the characters typed when regular expression is off, and as typed in case when case is on", () => {
    expect(find(read("a.b", { regex: false }).pattern, "A.B axb a.b")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(find(read("a.b", { regex: false, caseSensitive: true }).pattern, "A.B axb a.b")).toEqual([{ start: 8, end: 11 }]);
    expect(find(read("(", { regex: false }).pattern, "f(x)")).toEqual([{ start: 1, end: 2 }]);
  });

  it("matches a whole word only, with Unicode letters and the underscore making words, and an alternation whole", () => {
    const whole = (query: string, text: string, options: Partial<SearchOptions> = {}) =>
      find(read(query, { wholeWord: true, ...options }).pattern, text).map(({ start }) => start);
    expect(whole("cat", "cat concat cats caféx cat_ cat.")).toEqual([0, 27]);
    expect(whole("caf", "café caf")).toEqual([5]);
    expect(whole("é", "café é")).toEqual([5]);
    expect(whole("cat|dog", "dogs cat bobdog dog")).toEqual([5, 16]);
    expect(whole("a.b", "a.b axb", { regex: false })).toEqual([0]);
  });

  it("reports a query that is not a valid expression, which matches nothing, and reads it as characters when regular expression is off", () => {
    for (const options of [{}, { wholeWord: true }, { caseSensitive: true }]) {
      for (const query of ["(", "[a-", "a)(b", "*", "\\"]) {
        const { pattern, error } = read(query, options);
        expect(error, `${query} ${JSON.stringify(options)}`).toEqual(expect.any(String));
        expect(find(pattern, `${query} anything`)).toEqual([]);
      }
    }
    expect(read("(", { regex: false }).error).toBeUndefined();
    expect(createSearch()(layOut().every.rows, read("(").pattern).count).toBe(0);
  });

  it("finds no match where an expression matches nothing", () => {
    expect(find(read("x*").pattern, "axxb")).toEqual([{ start: 1, end: 3 }]);
    expect(find(read("^").pattern, "line\nline")).toEqual([]);
  });

  it("counts the matches in every block, hidden categories' included, in names, text, JSON and fields", () => {
    const { every } = layOut();
    const found = createSearch()(every.rows, pattern);
    // Each exchange: the header's value, the user's text, the tool call's name and its input's JSON, the tool result.
    expect(found.count).toBe(10);
    expect(found.blocks.map(({ count }) => count)).toEqual([1, 1, 2, 1, 1, 1, 2, 1]);
    const hidden = layOut({ ...shown, tools: "hidden", metadata: "hidden" });
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
    const hidden = stepsOf({ ...shown, tools: "hidden", metadata: "hidden" });
    expect(hidden).toEqual(stepsOf(shown));
    expect(hidden.ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("steps on from a current match in a hidden category to the match before and after it in the conversation", () => {
    const { every } = layOut({ ...shown, tools: "hidden" });
    const found = createSearch()(every.rows, pattern);
    const toolResult = adjacent(found, { key: "thread:a/message.2/content.0", at: address.part(1), start: -1 }, top, "next", pattern, every.keys)!.match;
    // After exchange a's tool result: exchange b's header; before it: the JSON of exchange a's tool call, also hidden.
    expect(adjacent(found, toolResult, top, "next", pattern, every.keys)!.match.key).toBe("b/request/http");
    expect(adjacent(found, toolResult, top, "previous", pattern, every.keys)!.match).toMatchObject({ key: "thread:a/message.1/content.0", at: address.part(1) });
  });

  it("lists a hidden category's block while it holds the current match, and no longer once a step moves on from it", () => {
    const hidden = { ...shown, tools: "hidden", metadata: "hidden" } as const;
    const { every } = layOut(hidden);
    const found = createSearch()(every.rows, pattern);
    const hiddenBlocksListed = (revealed?: string) =>
      layOut(hidden, revealed)
        .rows.filter((row) => row.kind === "block" && hidden[row.block.category] === "hidden")
        .map(({ key }) => key);
    expect(hiddenBlocksListed()).toEqual([]);
    const categoryOf = (key: string) => (every.rows.find((row) => row.key === key) as { block: { category: Category } }).block.category;
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
    expect(adjacent(found, replaced, top, "previous", pattern, keys)!.match).toMatchObject({ key: "thread:a/message.1/content.0", at: address.part(1) });
    // One whose exchange is not among the rows at all: the first match going on, the last going back.
    expect(adjacent(found, { ...replaced, key: "z/request/http" }, top, "next", pattern, keys)!.match.key).toBe("a/request/http");
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

  it("opens the block and every region holding a match, and nothing for a match on the block's line", () => {
    const { rows, keys } = layOut().every;
    const found = createSearch()(rows, pattern);
    const result = adjacent(found, { key: "thread:a/message.2/content.0", at: address.part(1), start: -1 }, top, "next", pattern, keys)!;
    // The tool result's part 0 is its tool_use_id; its text is part 1.
    const part = partKey("thread:a/message.2/content.0", address.part(1));
    expect(result).toEqual({
      match: { key: "thread:a/message.2/content.0", at: address.part(1), start: result.match.start },
      block: rows.find((row) => row.key === "thread:a/message.2/content.0"),
      regions: [regionKey(part, 1), regionKey(part, 3)],
    });
    const name = adjacent(found, { key: "thread:a/message.1/content.0", at: address.name, start: -1 }, top, "next", pattern, keys)!;
    expect(name).toMatchObject({ block: undefined, regions: [] });
  });

  it("gives the matches starting in a slice of a text", () => {
    const ranges = [
      { start: 2, end: 4 },
      { start: 8, end: 12 },
      { start: 20, end: 21 },
    ];
    expect(rangesIn(ranges, 0, 8)).toEqual([{ start: 2, end: 4 }]);
    expect(rangesIn(ranges, 8, 20)).toEqual([{ start: 8, end: 12 }]);
    expect(rangesIn(ranges, 4, 8)).toEqual([]);
    expect(rangesIn(ranges, 0, 30)).toEqual(ranges);
  });
});
