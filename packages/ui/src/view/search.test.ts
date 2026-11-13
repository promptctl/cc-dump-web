import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import type { Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import { parseSettings, type Visibility } from "../settings.ts";
import { regionKey } from "./regions.ts";
import { createGroupRows, createLayout, type Layout } from "./rows.ts";
import { address, adjacent, createSearch, find, ordinal, partKey, patternOf, pieces, shownTexts, type Match } from "./search.ts";

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
const shown = parseSettings(undefined).visibility;
const layOut = (visibility: Record<Category, Visibility> = shown): Layout =>
  createLayout(visibility, createGroupRows())(createFormatter()(exchanges([...request("a", body), ...request("b", body)])));
const pattern = patternOf("needle");
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

  it("matches the query's characters literally, in any case, and the empty query nowhere", () => {
    expect(find(patternOf("a.b"), "A.B axb a.b")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(find(patternOf(""), "anything")).toEqual([]);
  });

  it("counts the matches in the shown categories' blocks, in names, text, JSON and fields", () => {
    const { rows } = layOut();
    const found = createSearch()(rows, pattern);
    // Each exchange: the header's value, the user's text, the tool call's name and its input's JSON, the tool result.
    expect(found.count).toBe(10);
    expect(found.blocks.map(({ count }) => count)).toEqual([1, 1, 2, 1, 1, 1, 2, 1]);
    const hidden = layOut({ ...shown, tools: "hidden", metadata: "hidden" });
    expect(createSearch()(hidden.rows, pattern).count).toBe(2);
  });

  it("steps through the matches in order and wraps at either end, counting which is current", () => {
    const { rows, keys } = layOut();
    const found = createSearch()(rows, pattern);
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
    expect(seen[2]).toEqual({ key: "a/message.1/content.0", at: address.name, start: 10 });
    expect(adjacent(createSearch()(rows, patternOf("absent")), undefined, top, "next", patternOf("absent"), keys)).toBeUndefined();
  });

  it("steps on from a current match whose category is now hidden, from where it stood", () => {
    const all = layOut();
    const toolResult = adjacent(createSearch()(all.rows, pattern), { key: "a/message.2/content.0", at: address.part(1), start: -1 }, top, "next", pattern, all.keys)!.match;
    const { rows, keys } = layOut({ ...shown, tools: "hidden" });
    const found = createSearch()(rows, pattern);
    expect(ordinal(found, toolResult, pattern)).toBeUndefined();
    // After exchange a's tool result: exchange b's header; before it: exchange a's user text.
    expect(adjacent(found, toolResult, top, "next", pattern, keys)!.match.key).toBe("b/request/http");
    expect(adjacent(found, toolResult, top, "previous", pattern, keys)!.match.key).toBe("a/message.0/content.0");
  });

  it("steps on from a current match whose block the formatter replaced, from the row it was inside, as the view does", () => {
    const { rows, keys } = layOut();
    const found = createSearch()(rows, pattern);
    const replaced = { key: "a/message.1/content.0/so-far", at: address.part(0), start: 0 };
    expect(adjacent(found, replaced, top, "next", pattern, keys)!.match.key).toBe("a/message.2/content.0");
    expect(adjacent(found, replaced, top, "previous", pattern, keys)!.match).toMatchObject({ key: "a/message.1/content.0", at: address.part(1) });
    // One whose exchange is not among the rows at all: the first match going on, the last going back.
    expect(adjacent(found, { ...replaced, key: "z/request/http" }, top, "next", pattern, keys)!.match.key).toBe("a/request/http");
  });

  it("steps with no current match from the view's position: its top row's matches going on, those above it going back", () => {
    const { rows, keys } = layOut();
    const found = createSearch()(rows, pattern);
    const at = { at: "row", key: "b/message.0/content.0", offset: 40 } as const;
    expect(adjacent(found, undefined, at, "next", pattern, keys)!.match.key).toBe("b/message.0/content.0");
    expect(adjacent(found, undefined, at, "previous", pattern, keys)!.match.key).toBe("b/request/http");
    // At the end, going on wraps to the first match.
    expect(adjacent(found, undefined, { at: "end" }, "next", pattern, keys)!.match.key).toBe("a/request/http");
  });

  it("opens the block and every region holding a match, and nothing for a match on the block's line", () => {
    const { rows, keys } = layOut();
    const found = createSearch()(rows, pattern);
    const result = adjacent(found, { key: "a/message.2/content.0", at: address.part(1), start: -1 }, top, "next", pattern, keys)!;
    // The tool result's part 0 is its tool_use_id; its text is part 1.
    const part = partKey("a/message.2/content.0", address.part(1));
    expect(result).toEqual({
      match: { key: "a/message.2/content.0", at: address.part(1), start: result.match.start },
      block: rows.find((row) => row.key === "a/message.2/content.0"),
      regions: [regionKey(part, 1), regionKey(part, 3)],
    });
    const name = adjacent(found, { key: "a/message.1/content.0", at: address.name, start: -1 }, top, "next", pattern, keys)!;
    expect(name).toMatchObject({ block: undefined, regions: [] });
  });

  it("cuts a slice of a text where its matches begin and end, a match running past the slice cut at its edge", () => {
    const ranges = [
      { start: 2, end: 4 },
      { start: 8, end: 12 },
    ];
    expect(pieces("abcdefghij", 0, ranges)).toEqual([
      { text: "ab", match: undefined },
      { text: "cd", match: 2 },
      { text: "efgh", match: undefined },
      { text: "ij", match: 8 },
    ]);
    expect(pieces("klm", 10, ranges)).toEqual([
      { text: "kl", match: 8 },
      { text: "m", match: undefined },
    ]);
  });
});
