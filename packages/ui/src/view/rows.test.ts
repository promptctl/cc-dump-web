import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import type { Block, Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import { parseSettings, type Unchanged, type Visibility } from "../settings.ts";
import { createHistory } from "./history.ts";
import { clockTime, compact, context, createLayout, describeSize, estimateHeight, foldKey, isExpanded, preview, seconds, sizeOf, type Row } from "./rows.ts";

const timestamp = "2026-11-15T14:00:00.000Z";
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const request = (trace_id: string, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
const text = (text: string) => ({ type: "text", text });
// A thread of `turns` requests, each resending the last's messages and adding a user's, so each turn adds one message.
const turns = (count: number, system = "Be brief.") =>
  Array.from({ length: count }, (_, turn) =>
    request(`t${turn + 1}`, { model: "m", system: [text(system)], tools: [{ name: "Read" }], messages: Array.from({ length: turn + 1 }, (_, index) => ({ role: "user", content: [text(`Say ${index}.`)] })) }),
  ).flat();
const shown = parseSettings(undefined).visibility;
const dialogue = { ...shown, tools: "hidden", system: "hidden", metadata: "hidden", thinking: "hidden" } as const;

// The layout at each step of `events`, as the view lays them out.
function layouts(events: RecordedEvent[], visibility: Record<Category, Visibility> = shown, unchanged: Unchanged = "show") {
  const history = createHistory()(createFormatter()(exchanges(events)));
  const layOut = createLayout(visibility, unchanged);
  return (step: number, revealed?: string, opened: Record<string, true> = {}) => layOut(history, step, revealed, opened);
}
const listed = ({ rows }: { rows: Row[] }) => rows.map((row) => (row.kind === "fold" ? `${row.key} ${row.count}` : row.kind === "block" ? `${row.key} ${row.change}` : row.key));

describe("layout", () => {
  it("lays out the conversation at a step: each step's exchange, then what first arrived with it, the step shown's added", () => {
    const at = layouts(turns(2));
    expect(listed(at(1))).toEqual([
      "t1",
      "t1/request",
      "t1/request/http added",
      "thread:t1/request/parameters added",
      "thread:t1/request/tools added",
      "thread:t1/request/system.0 added",
      "t1/message.0",
      "thread:t1/message.0/content.0 added",
    ]);
    // The second turn resends the first: only its HTTP and its new message are its, and the first's rows are unchanged.
    expect(listed(at(2)).slice(8)).toEqual(["t2", "t2/request", "t2/request/http added", "t2/message.1", "thread:t1/message.1/content.0 added"]);
    expect(at(2).rows.slice(0, 8).every((row) => row.kind !== "block" || (row.change === "same" && row.before === row.block))).toBe(true);
    expect(at(2).rows.filter((row) => row.kind !== "block").map((row) => row.kind !== "fold" && row.change)).toEqual(["same", "same", "same", "added", "added", "added"]);
    // An added row has nothing before it; a step of 0 shows nothing.
    expect(at(2).rows.filter((row) => row.kind === "block" && row.change === "added").every((row) => row.kind === "block" && row.before === undefined)).toBe(true);
    expect(at(0).rows).toEqual([]);
  });

  it("marks a block a step gave a new version as changed, with the version before it on the left", () => {
    const at = layouts([...turns(1), ...request("t2", { model: "m", system: [text("Be briefer.")], tools: [{ name: "Read" }], messages: [{ role: "user", content: [text("Say 0.")] }] })]);
    const system = at(2).rows.find(({ key }) => key === "thread:t1/request/system.0");
    expect(system).toMatchObject({ change: "changed", before: { parts: [{ kind: "text", text: "Be brief." }] }, block: { parts: [{ kind: "text", text: "Be briefer." }] } });
    // At the step it arrived, the item is what it was then.
    expect(at(1).rows.find(({ key }) => key === "thread:t1/request/system.0")).toMatchObject({ change: "added", block: { parts: [{ kind: "text", text: "Be brief." }] } });
  });

  it("folds each run of unchanged rows beyond the context beside a change into one row, and lists an opened one", () => {
    const at = layouts(turns(4), shown, "fold");
    const step = at(4);
    const fold = step.rows[0]!;
    expect(fold).toMatchObject({ kind: "fold", key: foldKey("t1") });
    // Every row of the steps before but the context above the change.
    const unfolded = layouts(turns(4))(4);
    const firstChange = unfolded.rows.findIndex((row) => row.kind !== "fold" && row.change !== "same");
    expect(fold.kind === "fold" && fold.count).toBe(firstChange - context);
    expect(step.rows.slice(1, 1 + context)).toEqual(unfolded.rows.slice(firstChange - context, firstChange));
    // A folded row is at its fold.
    expect(step.keys.indexOf("thread:t1/request/system.0")).toBe(0);
    expect(step.keys.indexOf(foldKey("t1"))).toBe(0);
    expect(listed(at(4, undefined, { [foldKey("t1")]: true }))).toEqual(listed(unfolded));
    // An opened fold is at its first row, so a place held on it as it opens holds.
    const opened = at(4, undefined, { [foldKey("t1")]: true }).keys;
    expect(opened.at(opened.indexOf(foldKey("t1"))!)).toBe("t1");
    // A step with no step before it has nothing unchanged.
    const two = layouts(turns(2), shown, "fold")(2);
    expect(two.rows.some(({ kind }) => kind === "fold")).toBe(true);
    expect(layouts(turns(1), shown, "fold")(1).rows.some(({ kind }) => kind === "fold")).toBe(false);
  });

  it("never folds the block the search revealed, hidden or not", () => {
    const at = layouts(turns(4), shown, "fold");
    const revealed = "thread:t1/request/tools";
    expect(at(4).rows.map(({ key }) => key)).not.toContain(revealed);
    const keys = at(4, revealed).rows.map(({ key }) => key);
    expect(keys).toContain(revealed);
    expect(at(4, revealed).keys.indexOf(revealed)).toBe(keys.indexOf(revealed));
    const hidden = layouts(turns(4), { ...shown, tools: "hidden" }, "fold");
    expect(hidden(4, revealed).rows.map(({ key }) => key)).toContain(revealed);
    expect(hidden(4).rows.map(({ key }) => key)).not.toContain(revealed);
  });

  it("leaves out a hidden category's blocks, and a group with none left, and puts a row not listed at the row listed before it", () => {
    const at = layouts(turns(2), dialogue);
    expect(listed(at(2))).toEqual(["t1", "t1/message.0", "thread:t1/message.0/content.0 same", "t2", "t2/message.1", "thread:t1/message.1/content.0 added"]);
    const { keys } = at(2);
    expect(keys.at(keys.indexOf("t1/request/http")!)).toBe("t1");
    expect(keys.at(keys.indexOf("thread:t1/request/system.0")!)).toBe("t1");
    expect(keys.at(keys.indexOf("t2/request/http")!)).toBe("t2");
    expect(keys.indexOf("t3")).toBeUndefined();
  });

  it("keeps every row, listed or not, in order, as one object while no block of it changed, and the keys while no row moved", () => {
    const at = layouts(turns(3), { ...shown, tools: "hidden" });
    const first = at(3);
    const everyKey = first.every.rows.map(({ key }) => key);
    expect(everyKey).toContain("thread:t1/request/tools");
    expect(everyKey.map((key) => first.every.keys.indexOf(key))).toEqual(everyKey.map((_, index) => index));
    const revealed = at(3, "thread:t1/request/tools");
    expect(revealed.every).toBe(first.every);
    expect(revealed.keys).not.toBe(first.keys);
    expect(at(3).keys).not.toBe(revealed.keys);
    expect(at(3).keys).toBe(at(3).keys);
    // Another step is other rows.
    expect(at(2).every).not.toBe(first.every);
  });

  it("keeps the keys while what a row shows changes and no row moves, as while a block streams", () => {
    const events = turns(3);
    const layOut = createLayout(shown, "show");
    // Two formatters make the same rows of other block objects.
    const first = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    const again = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    expect(again.every).not.toBe(first.every);
    expect(again.keys).toBe(first.keys);
  });

  it("gives other keys when a hidden block arrives, though the rows listed are the same, since where a hidden row stands moved", () => {
    const t1 = turns(1);
    const t2 = request("t2", { model: "m", system: [text("Be brief."), text("Mind the tools.")], tools: [{ name: "Read" }], messages: [{ role: "user", content: [text("Say 0.")] }] });
    const history = createHistory();
    const format = createFormatter();
    const layOut = createLayout({ ...shown, system: "hidden", metadata: "hidden" }, "show");
    const before = layOut(history(format(exchanges([...t1, ...t2.slice(0, 1)]))), 2, undefined, {});
    const after = layOut(history(format(exchanges([...t1, ...t2]))), 2, undefined, {});
    expect(listed(after)).toEqual(listed(before));
    expect(after.every.rows.map(({ key }) => key)).toContain("thread:t1/request/system.1");
    expect(after.keys).not.toBe(before.keys);
  });

  it("starts each side of a row as its own version starts, a user's or an assistant's block expanded and what the harness injected collapsed, and one flip turns both", () => {
    const block = (category: Category, injected: boolean): Block => ({ category, name: "n", parts: [], ...(injected ? { injected: true as const } : {}) });
    const [said, reminder, tools] = [block("user", false), block("user", true), block("tools", false)];
    expect([said, reminder, tools].map((side) => isExpanded({}, "k", side))).toEqual([true, false, false]);
    expect([said, reminder, tools].map((side) => isExpanded({ k: true }, "k", side))).toEqual([false, true, true]);
    const row: Row = { kind: "block", key: "k", block: { ...said, key: "c", parts: [{ kind: "text", text: "x".repeat(1000) }] }, before: { ...tools, key: "c" }, change: "changed" };
    expect(estimateHeight(row, {})).toBe(20 + 10 * 16);
    expect(estimateHeight(row, { k: true })).toBe(20);
  });
});

describe("a block's line", () => {
  it("sizes a block by the characters of its content", () => {
    expect(sizeOf({ category: "user", name: "text", parts: [{ kind: "text", text: "Hello." }, { kind: "fields", fields: [["id", "t1"]] }] })).toBe("Hello.".length + 4);
    expect([999, 12_345, 999_949, 999_960, 2_500_000].map(describeSize)).toEqual(["999 chars", "12.3k chars", "999.9k chars", "1.0M chars", "2.5M chars"]);
    expect([999, 12_345, 999_960].map(compact)).toEqual(["999", "12.3k", "1.0M"]);
  });

  it("previews a block by the start of its first text or JSON, on one line, and prints a line's time and duration", () => {
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "  Hello.\n\nSecond   line" }] })).toBe("Hello. Second line");
    expect(preview({ category: "tools", name: "tool_use: Bash", parts: [{ kind: "fields", fields: [["id", "t1"]] }, { kind: "json", label: "input", value: { command: "ls -la" } }] })).toBe('{ "command": "ls -la" }');
    expect(preview({ category: "tools", name: "tool_result", parts: [{ kind: "fields", fields: [["tool_use_id", "t1"]] }] })).toBe("");
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "x".repeat(500) }] })).toBe(`${"x".repeat(200)}…`);
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "x".repeat(200) }] })).toBe("x".repeat(200));
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: `${"x".repeat(200)}\n\n` }] })).toBe("x".repeat(200));
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: `${"x".repeat(199)}🙂 more` }] })).toBe(`${"x".repeat(199)}…`);
    expect(preview({ category: "tools", name: "tool_use: Bash", parts: [{ kind: "json", label: "input", value: '{"command": "ls' }] })).toBe('{"command": "ls');
    // Deep JSON's indentation does not use up the line.
    const deep = { a: { b: { c: { d: Array.from({ length: 60 }, (_, index) => index) } } } };
    expect(preview({ category: "metadata", name: "usage", parts: [{ kind: "json", value: deep }] })).toMatch(/^.{198,200}…$/u);
    expect(clockTime("2026-11-13T08:00:00.000Z")).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(seconds(2100)).toBe("2.1s");
  });
});
