import { eventsWritten } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { formatBlock, type Block } from "../format/blocks.ts";
import { keyed } from "../format/format.ts";
import { defaultSettings } from "../settings.ts";
import { columnOf, standingIn } from "../testing.ts";
import { viewLog } from "./decisions.ts";
import { currentOf, judge, matchMove, waitingOf } from "./moves.ts";
import type { BlockRow } from "./rows.ts";
import { createSearch, keyAt, literal, ordinal, patternOf, resolve, shownTexts, type Current, type Match } from "./search.ts";
import type { Folded } from "./rendering.ts";

// A block's row as a step shows it, keyed `k`: the formatter's own block, made from a content block as sent, `content`,
// in a message of the assistant's.
const rowOf = (content: unknown): BlockRow => {
  const block: Block = formatBlock(content, "assistant", "markdown", []);
  const shown = keyed(block, "k");
  return { kind: "block", key: "k", change: "added", versions: [{ step: 1, block: shown, reply: true, rewrote: undefined, previous: undefined }], at: 0, set: undefined, depth: 0, dimmed: false };
};

const { search: defaults } = defaultSettings;
const { pattern } = patternOf("needle", defaults);
// The current match, as a step takes it: the `nth` match, counting from 0, of the text at `at` in the row.
const taken = (match: Match, under = pattern): Current => ({ ...match, pattern: literal(under) });
// What a match names in a row as the row shows now: its text, the characters before it there, and its own.
const named = (row: BlockRow, match: Match) => {
  const resolved = resolve(row, match, pattern);
  if (!resolved.resolved) throw new Error(`${JSON.stringify(match)} resolves to none: ${resolved.why}`);
  const { text } = resolved.shown.searched;
  return { text, before: text.slice(0, resolved.range.start), match: text.slice(resolved.range.start, resolved.range.end) };
};
// The address of the text `text` among those the row shows.
const addressOf = (row: BlockRow, text: string): string => shownTexts(row).find(({ searched }) => searched.text === text)!.at;

describe("a match and an open section as a tool call's input streams and becomes whole", () => {
  // An Edit call whose input carries an `id` of its own: as it streams, its input so far, then the block's id; whole,
  // its file, its change, its fields no entry reads, among them its own id, then the block's id.
  const call = (input: unknown) => rowOf({ type: "tool_use", id: "toolu_needle", name: "Edit", input });
  const soFar = call('{"file_path":"a.ts","id":"needle-7"');
  const whole = call({ file_path: "a.ts", old_string: "x", new_string: "y", id: "needle-7" });

  it("adds parts of the block id's kind and label ahead of it as the input becomes whole", () => {
    const shapeOf = (row: BlockRow) => (row.versions[0]!.block as Block).parts.map(({ kind, label }) => [kind, label]);
    expect(shapeOf(soFar)).toEqual([["text", "input so far"], ["fields", undefined]]);
    expect(shapeOf(whole)).toEqual([["fields", undefined], ["diff", "old_string → new_string"], ["fields", undefined], ["fields", undefined]]);
  });

  it("keeps a current match on the block's id, apart from the input's own id, and the counter on it", () => {
    const current: Match = { key: "k", at: addressOf(soFar, "toolu_needle"), nth: 0 };
    expect(named(soFar, current)).toMatchObject({ text: "toolu_needle", match: "needle" });
    expect(named(whole, current)).toMatchObject({ text: "toolu_needle", match: "needle" });
    // The input's own id is a text of its own.
    expect(addressOf(whole, "needle-7")).not.toBe(current.at);
    for (const row of [soFar, whole]) expect(ordinal(createSearch()([row], pattern), standingIn(columnOf([row]), taken(current), pattern))).toBe(2);
  });

  it("keeps what opens in a text of the block under the same key, by the text's address", () => {
    const at = addressOf(soFar, "toolu_needle");
    expect(keyAt({ blockKey: "k", at }, 0)).toBe(keyAt({ blockKey: "k", at: addressOf(whole, "toolu_needle") }, 0));
  });

  it("clears a current match in the input so far once it is whole, which shows no text there, and says where it was and why", () => {
    const inSoFar = taken({ key: "k", at: addressOf(soFar, '{"file_path":"a.ts","id":"needle-7"'), nth: 0 });
    const judged = judge(columnOf([whole]), inSoFar, pattern);
    expect(judged).toEqual({ is: "cleared", cleared: { ...inSoFar, why: "text_gone", searching: literal(pattern) } });
    const { events, log } = eventsWritten();
    if (judged.is === "cleared") viewLog(log).matchCleared(judged.cleared);
    expect(events).toEqual([expect.objectContaining({ event: "match_cleared", key: "k", at: inSoFar.at, nth: 0, why: "text_gone", pattern: literal(pattern), searching: literal(pattern) })]);
  });
});

describe("a current match in a streaming Markdown text", () => {
  const textRow = (text: string) => rowOf({ type: "text", text });
  // The current match: the `nth` needle of the text of `text`'s row.
  const at = (text: string, nth: number): Match => ({ key: "k", at: addressOf(textRow(text), renderedOf(text)), nth });
  const renderedOf = (text: string) => (shownTexts(textRow(text)).find(({ in: where }) => where === "regions")!.searched as Folded).text;
  // The match in the text before and after it grows, as what precedes it reads.
  const across = (before: string, after: string, nth: number) => [named(textRow(before), at(before, nth)), named(textRow(after), at(before, nth))];

  it("stays on its match as text is added after it", () => {
    const [was, is] = across("find the needle", "find the needle and another needle", 0);
    expect(is).toMatchObject({ before: was!.before, match: "needle" });
  });

  it("stays on its match as markup ahead of it closes", () => {
    const [bold, boldAfter] = across("a needle **b needle", "a needle **b needle**", 1);
    expect([bold!.before, boldAfter!.before]).toEqual(["a needle **b ", "a needle b "]);
    const [code, codeAfter] = across("needle `a\nb c d needle", "needle `a\nb c d needle`", 1);
    expect([code!.match, codeAfter!.match]).toEqual(["needle", "needle"]);
    expect(codeAfter!.before).toBe("needle a b c d ");
  });

  it("stays on its match when the text ahead of it holds a code span with a newline, a linked URL with a percent escape, or an entity", () => {
    for (const ahead of ["`x\ny` ", "[a link](https://example.com/a%20b) ", "&amp; "]) {
      const [was, is] = across(`needle ${ahead}needle`, `needle ${ahead}needle and needle`, 1);
      expect(is).toMatchObject({ before: was!.before, match: "needle" });
      expect(is!.before.match(/needle/g)).toHaveLength(1);
    }
  });

  it("is none once its text holds fewer matches, for the counter, the steps and the log alike", () => {
    // The literal asterisks a reader saw are markup once closed, so the match is no longer there.
    const stars = patternOf(String.raw`\*\*`, defaults).pattern;
    const before = textRow("**a");
    const after = textRow("**a**");
    const current = taken({ key: "k", at: addressOf(before, "**a"), nth: 0 }, stars);
    expect(resolve(before, current, stars)).toMatchObject({ resolved: true, range: { start: 0, end: 2 } });
    const judged = judge(columnOf([after]), current, stars);
    expect(judged).toEqual({ is: "cleared", cleared: { ...current, why: "text_changed", searching: literal(stars) } });
    expect(currentOf(judged)).toBeUndefined();
  });
});

describe("the current match under a change of how the query is read", () => {
  const row = rowOf({ type: "text", text: "a needle" });
  const column = columnOf([row]);
  const current = taken({ key: "k", at: addressOf(row, "a needle"), nth: 0 });

  it("stands under the same query read the same way, however often it is read again", () => {
    expect(judge(column, current, patternOf("needle", defaults).pattern)).toEqual({ is: "found", match: current, place: { at: "row", index: 0, offset: 0 }, index: 0, range: { start: 2, end: 8 } });
  });

  it("is none under another query, or the query read another way, whichever tab changed it, for the counter, the steps and the line alike", () => {
    const place = { at: "start" } as const;
    for (const now of [patternOf("needles", defaults), patternOf("needle", { ...defaults, wholeWord: true }), patternOf("needle", { ...defaults, caseSensitive: true }), patternOf("", defaults)]) {
      const judged = judge(column, current, now.pattern);
      expect(judged).toMatchObject({ is: "cleared", cleared: { why: "pattern_changed", pattern: literal(pattern), searching: literal(now.pattern) } });
      // What the view gives every reader of the current match: none, so each reads as with no current match.
      const standing = currentOf(judged);
      const found = createSearch()([row], now.pattern);
      expect(ordinal(found, standing)).toBeUndefined();
      expect(matchMove(column, found, standing, place, "next", now.pattern)).toEqual(matchMove(column, found, undefined, place, "next", now.pattern));
      expect(waitingOf(column, place, standing)).toBeUndefined();
    }
  });
});

describe("a block with two parts of one name", () => {
  it("is the formatter's error, which it throws, naming the block and the name", () => {
    const block: Block = { category: "tools", name: "tool_use: X", parts: [{ id: "a", kind: "text", form: "verbatim", text: "one" }, { id: "a", kind: "text", form: "verbatim", text: "two" }] };
    expect(() => keyed(block, "k")).toThrow('The formatter made the block k with two parts named "a"');
  });
});
