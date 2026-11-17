import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { categories, type Block, type Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import type { Part } from "../format/parts.ts";
import type { Branches, Visibility } from "../settings.ts";
import { createHistory } from "./history.ts";
import { createSearch } from "./search.ts";
import { clockTime, compact, createLayout, describeSize, estimateHeight, foldKey, isGone, markOf, modelName, pastOf, preview, seconds, sizeOf, startsExpanded, type BlockRow, type Opened, type Row } from "./rows.ts";

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
// Every category listed, a block a line.
const shown = Object.fromEntries(categories.map((category) => [category, "compact"])) as Record<Category, Visibility>;
const dialogue = { ...shown, tools: "hidden", system: "hidden", metadata: "hidden", thinking: "hidden" } as const;

// The layout at each step of `events`, as the view lays them out.
function layouts(events: RecordedEvent[], visibility: Record<Category, Visibility> = shown, branches: Branches = "stay") {
  const history = createHistory()(createFormatter()(exchanges(events)));
  const layOut = createLayout(visibility, branches);
  return (step: number, revealed?: string, opened: Opened = {}) => layOut(history, step, revealed, opened);
}
// The block's row at `key` among a layout's.
const blockAt = ({ rows }: { rows: Row[] }, key: string) => rows.find((row): row is BlockRow => row.kind === "block" && row.key === key)!;
const listed = ({ rows }: { rows: Row[] }) => rows.map((row) => (row.kind === "fold" ? `${row.key} ${row.rows.length}` : row.kind === "block" ? `${row.key} ${row.change}` : row.key));

describe("layout", () => {
  it("lays out the conversation at a step: each step's exchange, then what first arrived with it, the step shown's added", () => {
    const at = layouts(turns(2));
    expect(listed(at(1))).toEqual([
      "t1",
      "t1/request",
      "t1/request/http added",
      "thread:t1/request/parameters added",
      "thread:t1/request/tools.Read.0 added",
      "thread:t1/request/system.0 added",
      "t1/message.0",
      "thread:t1/message.0/content.0 added",
    ]);
    // The second turn resends the first: only its HTTP and its new message are its, and the first's rows are unchanged.
    expect(listed(at(2)).slice(8)).toEqual(["t2", "t2/request", "t2/request/http added", "t2/message.1", "thread:t2/message.1/content.0 added"]);
    expect(at(2).rows.slice(0, 8).every((row) => row.kind !== "block" || row.change === "same")).toBe(true);
    expect(at(2).rows.filter((row) => row.kind !== "block").map((row) => row.kind !== "fold" && row.change)).toEqual(["same", "same", "same", "added", "added", "added"]);
    // A block as it arrived has no past, at its step or after; a step of 0 shows nothing.
    expect(at(2).rows.every((row) => row.kind !== "block" || (pastOf(row).length === 0 && markOf(row) === row.change))).toBe(true);
    expect(at(0).rows).toEqual([]);
  });

  it("marks a block a step rewrote as changed, and keeps what the step rewrote as its past at every step after", () => {
    // The second turn edits the system prompt in place, carrying the thread on; the third resends it as the second left it.
    const turn = (trace: string, count: number) => request(trace, { model: "m", system: [text("Be briefer.")], tools: [{ name: "Read" }], messages: say(count) });
    const at = layouts([...turns(1), ...turn("t2", 2), ...turn("t3", 3)]);
    const system = (step: number) => blockAt(at(step), "thread:t1/request/system.0");
    const rewrite = { step: 2, change: "changed", before: { parts: [{ kind: "text", text: "Be brief." }] }, after: { parts: [{ kind: "text", text: "Be briefer." }] } };
    expect(system(2)).toMatchObject({ change: "changed", block: rewrite.after });
    expect(pastOf(system(2))).toMatchObject([rewrite]);
    // The step after left it as it was, and its past and its mark still say the rewrite.
    expect(system(3)).toMatchObject({ change: "same", block: rewrite.after });
    expect(pastOf(system(3))).toEqual(pastOf(system(2)));
    expect([system(2), system(3)].map(markOf)).toEqual(["changed", "changed"]);
    // At the step it arrived, the item is what it was then, with no past.
    expect(system(1)).toMatchObject({ change: "added", block: rewrite.before });
    expect(pastOf(system(1))).toEqual([]);
  });

  it("marks exactly the tool a request changed, dropped or added, the rest unchanged, and a prompt block dropped as removed the step it goes", () => {
    const tool = (name: string, description: string) => ({ name, description, input_schema: {} });
    const messages = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "user", content: [text(`Say ${index}.`)] }));
    const turn = (trace: string, count: number, tools: unknown[], system: string[]) => request(trace, { model: "m", system: system.map(text), tools, messages: messages(count) });
    const at = layouts([
      ...turn("t1", 1, [tool("Read", "Reads"), tool("Edit", "Edits"), tool("Bash", "Runs")], ["Be brief.", "Mind the tools."]),
      ...turn("t2", 2, [tool("Read", "Reads"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
      ...turn("t3", 3, [tool("Read", "Reads"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
      ...turn("t4", 4, [tool("Read", "Reads"), tool("Edit", "Edits"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
    ]);
    const prompt = (step: number) => listed(at(step)).filter((row) => /request\/(tools|system)/.test(row));
    // Each tool is its own item, lined up by its name: Bash changed, Edit gone, Grep come, Read as it was.
    expect(prompt(2)).toEqual([
      "thread:t1/request/tools.Read.0 same",
      "thread:t1/request/tools.Edit.0 removed",
      "thread:t1/request/tools.Bash.0 changed",
      "thread:t1/request/system.0 same",
      "thread:t1/request/system.1 removed",
      "thread:t2/request/tools.Grep.0 added",
    ]);
    const edit = (step: number) => blockAt(at(step), "thread:t1/request/tools.Edit.0");
    // Its row shows the block it was.
    expect(edit(2)).toMatchObject({ block: { name: "Edit" } });
    expect(isGone(edit(2))).toBe(true);
    // Taken away, it stays listed where it stood, the step after leaving it and every other row as they were; its past
    // and its mark still say it went.
    expect(prompt(3)).toEqual([
      "thread:t1/request/tools.Read.0 same",
      "thread:t1/request/tools.Edit.0 same",
      "thread:t1/request/tools.Bash.0 same",
      "thread:t1/request/system.0 same",
      "thread:t1/request/system.1 same",
      "thread:t2/request/tools.Grep.0 same",
    ]);
    expect([isGone(edit(3)), pastOf(edit(3)), markOf(edit(3))]).toEqual([true, [{ step: 2, change: "removed" }], "removed"]);
    // Offered again, it is there again, added, with both steps in its past.
    expect(prompt(4).filter((row) => !row.endsWith("same"))).toEqual(["thread:t1/request/tools.Edit.0 added"]);
    expect([isGone(edit(4)), pastOf(edit(4))]).toEqual([false, [{ step: 2, change: "removed" }, { step: 4, change: "added" }]]);
  });

  it("marks a block a request stops sending inside a message it resends removed, the step it goes", () => {
    const at = layouts([
      ...request("t1", { model: "m", messages: [...say(1), { role: "user", content: [text("Say 1."), text("Mind it.")] }] }),
      ...request("t2", { model: "m", messages: [...say(3)] }),
    ]);
    expect(at(2).rows.find(({ key }) => key === "thread:t1/message.1/content.1")).toMatchObject({ change: "removed", block: { parts: [{ text: "Mind it." }] } });
    expect(listed(at(2))).toContain("thread:t1/message.1/content.0 same");
    expect(listed(at(2))).toContain("thread:t2/message.2/content.0 added");
  });

  it("leaves out a hidden category's blocks, and a group with none left, and puts a row not listed at the row listed before it", () => {
    const at = layouts(turns(2), dialogue);
    expect(listed(at(2))).toEqual(["t1", "t1/message.0", "thread:t1/message.0/content.0 same", "t2", "t2/message.1", "thread:t2/message.1/content.0 added"]);
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
    expect(everyKey).toContain("thread:t1/request/tools.Read.0");
    expect(everyKey.map((key) => first.every.keys.indexOf(key))).toEqual(everyKey.map((_, index) => index));
    const revealed = at(3, "thread:t1/request/tools.Read.0");
    expect(revealed.every).toBe(first.every);
    expect(revealed.keys).not.toBe(first.keys);
    expect(at(3).keys).not.toBe(revealed.keys);
    expect(at(3).keys).toBe(at(3).keys);
    // Another step is other rows.
    expect(at(2).every).not.toBe(first.every);
  });

  it("keeps the keys while what a row shows changes and no row moves, as while a block streams", () => {
    const events = turns(3);
    const layOut = createLayout(shown, "stay");
    // Two formatters make the same rows of other block objects.
    const first = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    const again = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    expect(again.every).not.toBe(first.every);
    expect(again.keys).toBe(first.keys);
  });

  it("gives other keys when a hidden block arrives, though the rows listed are the same, since where a hidden row stands moved", () => {
    const t1 = turns(1);
    const messages = [0, 1].map((index) => ({ role: "user", content: [text(`Say ${index}.`)] }));
    const t2 = request("t2", { model: "m", system: [text("Be brief."), text("Mind the tools.")], tools: [{ name: "Read" }], messages });
    const history = createHistory();
    const format = createFormatter();
    const layOut = createLayout({ ...shown, user: "hidden", system: "hidden", metadata: "hidden" }, "stay");
    const before = layOut(history(format(exchanges([...t1, ...t2.slice(0, 1)]))), 2, undefined, {});
    const after = layOut(history(format(exchanges([...t1, ...t2]))), 2, undefined, {});
    expect(listed(after)).toEqual(listed(before));
    expect(after.every.rows.map(({ key }) => key)).toContain("thread:t2/request/system.1");
    expect(after.keys).not.toBe(before.keys);
  });

  it("starts a block's row as its category's level says, and what the harness injected, a block a step took away or a hidden category's revealed block collapsed", () => {
    const block = (category: Category, injected: boolean): Block => ({ category, name: "n", parts: [], ...(injected ? { injected: true as const } : {}) });
    const [said, reminder, tools] = [block("user", false), block("user", true), block("tools", false)];
    const row = (side: Block, gone = false): BlockRow => {
      const shown = { ...side, key: "c" };
      return { kind: "block", key: "k", block: shown, change: gone ? "removed" : "added", versions: [gone ? { step: 1, block: undefined, was: shown } : { step: 1, block: shown, reply: false }], at: 0, branch: undefined };
    };
    const levels = { ...shown, user: "expanded", tools: "compact" } as const;
    expect([said, reminder, tools].map((side) => startsExpanded(row(side), levels))).toEqual([true, false, false]);
    expect([said, reminder, tools].map((side) => startsExpanded(row(side), { ...levels, user: "compact", tools: "expanded" }))).toEqual([false, false, true]);
    expect(startsExpanded(row(tools), { ...levels, tools: "hidden" })).toBe(false);
    expect(startsExpanded(row(said, true), levels)).toBe(false);
    // A row is estimated as it starts; the reader's choice outranks the start.
    const long = row({ ...said, parts: [{ kind: "text", form: "markdown", text: "x".repeat(1000) }] });
    expect(estimateHeight(long, {}, levels)).toBe(20 + 10 * 16);
    expect(estimateHeight(long, { k: false }, levels)).toBe(20);
    expect(estimateHeight(long, {}, { ...levels, user: "compact" })).toBe(20);
    expect(estimateHeight(long, { k: true }, { ...levels, user: "compact" })).toBe(20 + 10 * 16);
  });

  it("lists a hidden category's blocks at neither level but the search's revealed one", () => {
    const keys = (visibility: Record<Category, Visibility>, revealed?: string) => listed(layouts(turns(1), visibility)(1, revealed));
    expect(keys({ ...shown, tools: "expanded" })).toEqual(keys(shown));
    expect(keys({ ...shown, tools: "hidden" })).not.toContain("thread:t1/request/tools.Read.0 added");
    expect(keys({ ...shown, tools: "hidden" }, "thread:t1/request/tools.Read.0")).toContain("thread:t1/request/tools.Read.0 added");
  });

  // The virtualizer keeps a row's measured height by this key, so a height measured open is not read for the row closed.
  it("measures a block's row by its key and whether it shows open, and keeps the keys while neither changes", () => {
    const system = "thread:t1/request/system.0";
    const at = (visibility: Record<Category, Visibility>, opened: Opened = {}) => {
      const layOut = layouts(turns(2), visibility);
      const { keys, rows } = layOut(2, undefined, opened);
      return { keys, again: layOut(2, undefined, opened).keys, measured: rows.map((_, index) => keys.measuredBy(index)) };
    };
    const compact = at(shown);
    const expanded = at({ ...shown, system: "expanded" });
    expect(compact.again).toBe(compact.keys);
    expect(compact.measured).toContain(`${system}#closed`);
    expect(expanded.measured).toContain(`${system}#open`);
    // Rows that are not a block's, and blocks the level does not start differently, are measured by the same key at both.
    expect(expanded.measured.filter((key) => !key.startsWith(system))).toEqual(compact.measured.filter((key) => !key.startsWith(system)));
    // A choice decides as the level does: a block opened at compact is measured as the one expanded starts open, and one
    // closed at expanded as the one compact starts closed.
    expect(at(shown, { [system]: true }).measured).toEqual(expanded.measured);
    expect(at({ ...shown, system: "expanded" }, { [system]: false }).measured).toEqual(compact.measured);
  });
});

describe("a block's line", () => {
  it("sizes a block by the characters of its content", () => {
    expect(sizeOf({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: "Hello." }, { kind: "fields", fields: [["id", "t1"]] }] })).toBe("Hello.".length + 4);
    expect([999, 12_345, 999_949, 999_960, 2_500_000].map(describeSize)).toEqual(["999 chars", "12.3k chars", "999.9k chars", "1.0M chars", "2.5M chars"]);
    expect([999, 12_345, 999_960].map(compact)).toEqual(["999", "12.3k", "1.0M"]);
  });

  it("previews a block by the start of its first part with anything to read, on one line", () => {
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: "  Hello.\n\nSecond   line" }] })).toBe("Hello. Second line");
    // A Markdown text reads as it is rendered, its syntax gone and each block apart from the next.
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: "## Plan\n**first** `x`\n- one\n- two" }] })).toBe("Plan first x one two");
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "verbatim", text: "## Plan **first**" }] })).toBe("## Plan **first**");
    // A JSON object reads as the fields it holds.
    expect(preview({ category: "tools", name: "tool_use: Skill", parts: [{ kind: "json", label: "input", value: { skill: "laws:code" } }, { kind: "fields", fields: [["id", "t1"]] }] })).toBe('skill "laws:code"');
    // A part with nothing to read, as a thinking block's omitted text is, is passed over.
    const thinking: Block = { category: "thinking", name: "thinking", parts: [{ kind: "text", form: "markdown", text: "" }, { kind: "fields", fields: [["signature", "924 characters"]] }] };
    expect(preview(thinking)).toBe("signature 924 characters");
    expect(preview({ category: "tools", name: "tool_use: Read", parts: [{ kind: "fields", fields: [["file_path", "/a.ts"], ["limit", "5"]] }] })).toBe("file_path /a.ts limit 5");
    expect(preview({ category: "tools", name: "tool_use: Edit", parts: [{ kind: "diff", before: "old", after: "new" }] })).toBe("old new");
    expect(preview({ category: "user", name: "image", parts: [{ kind: "media", of: "image", source: { type: "url", url: "u" } }] })).toBe("");
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: "x".repeat(500) }] })).toBe(`${"x".repeat(200)}…`);
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: "x".repeat(200) }] })).toBe("x".repeat(200));
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: `${"x".repeat(200)}\n\n` }] })).toBe("x".repeat(200));
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", form: "markdown", text: `${"x".repeat(199)}🙂 more` }] })).toBe(`${"x".repeat(199)}…`);
    expect(preview({ category: "tools", name: "tool_use: Bash", parts: [{ kind: "json", label: "input", value: '{"command": "ls' }] })).toBe('{"command": "ls');
    // A field that holds fields reads as theirs, each by its path; a null holds nothing to read.
    const nested: Block = { category: "metadata", name: "parameters", parts: [{ kind: "fields", fields: [["model", '"m"'], ["stop", "null"], ["thinking", [["type", '"adaptive"'], ["list", [["0", "1"]]]]]] }] };
    expect(preview(nested)).toBe('model "m" thinking.type "adaptive" thinking.list.0 1');
    // A JSON value that is a null reads as one a field holds.
    expect(preview({ category: "metadata", name: "error", parts: [{ kind: "json", value: null }] })).toBe("");
    expect(preview({ category: "metadata", name: "error", parts: [{ kind: "json", value: 5 }] })).toBe("5");
    // Deep JSON reads as its leaves, cut where the line ends.
    const deep = { a: { b: { c: { d: Array.from({ length: 60 }, (_, index) => index) } } } };
    const line = preview({ category: "metadata", name: "usage", parts: [{ kind: "json", value: deep }] });
    expect(line).toMatch(/^a\.b\.c\.d\.0 0 a\.b\.c\.d\.1 1 /);
    expect(line).toMatch(/^.{198,200}…$/u);
  });

  it("previews a block by its own preview when it has one, nothing when that holds nothing", () => {
    const reminder = "<system-reminder>\nContext left: 80%.\n</system-reminder>";
    const parts: Part[] = [{ kind: "text", form: "markdown", text: reminder }];
    expect(preview({ category: "user", name: "system reminder", parts, preview: [{ kind: "text", form: "markdown", text: "\nContext left: 80%.\n" }] })).toBe("Context left: 80%.");
    expect(preview({ category: "metadata", name: "stop reason: end_turn", parts, preview: [{ kind: "fields", fields: [["stop_sequence", "null"]] }] })).toBe("");
    // Its first part with anything to read, as a block's own are read.
    expect(preview({ category: "user", name: "text", parts, preview: [{ kind: "text", form: "markdown", text: "" }, { kind: "fields", label: "fields", fields: [["foo", "1"]] }] })).toBe("foo 1");
  });
});

describe("an exchange's line", () => {
  it("prints its time, its duration, and its model without the prefix every Anthropic model id has", () => {
    expect(clockTime("2026-11-13T08:00:00.000Z")).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(seconds(2100)).toBe("2.1s");
    expect(["claude-opus-5-5", "claude-haiku-5-5-20261001", "m", "my-claude-x"].map(modelName)).toEqual(["opus-5-5", "haiku-5-5-20261001", "m", "my-claude-x"]);
  });
});

// A side request, re-asking the second turn with a block of its own in the last message, then two turns of the thread:
// a branch at step 3 (view/lines.ts), the thread's turns at steps 4 and 5.
const say = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "user", content: [text(`Say ${index}.`)] }));
const thread = (trace: string, messages: unknown[]) => request(trace, { model: "m", system: [text("Be brief.")], tools: [{ name: "Read" }], messages });
const branched = [...turns(2), ...thread("side", [...say(1), { role: "user", content: [text("Say 1."), text("Aside.")] }]), ...thread("t3", say(3)), ...thread("t4", say(4))];

describe("branches", () => {
  it("lists a branch where it arrived, as it was, at every later step, marked as the branch it is", () => {
    const at = layouts(branched, shown, "stay");
    expect(listed(at(3))).toContain("thread:side/message.1/content.1 added");
    expect(listed(at(5))).toContain("thread:side/message.1/content.1 same");
    expect(at(5).rows.find(({ key }) => key === "side")).toMatchObject({ kind: "exchange", branch: { key: "branch:side", from: 2 } });
  });

  it("folds a branch into one row once its last request is behind the step shown, opened by its flip or a block revealed in it", () => {
    const at = layouts(branched, shown, "fold");
    expect(listed(at(3))).toContain("thread:side/message.1/content.1 added");
    const folded = at(4).rows.filter(({ kind }) => kind === "fold");
    expect(folded).toMatchObject([{ kind: "fold", key: "side", branch: { key: "branch:side", from: 2 } }]);
    expect(folded[0]!.kind === "fold" && folded[0]!.rows.length).toBe(5);
    // Its rows are still the search's, and stand where the fold does.
    expect(at(4).every.rows.map(({ key }) => key)).toContain("thread:side/message.1/content.1");
    expect(at(4).keys.indexOf("thread:side/message.1/content.1")).toBe(at(4).keys.indexOf("side"));
    expect(listed(at(4, undefined, { [foldKey("side")]: true }))).toContain("thread:side/message.1/content.1 same");
    expect(listed(at(4, "thread:side/message.1/content.1"))).toContain("thread:side/message.1/content.1 same");
  });

  it("marks a prompt block a branch stops sending, which the line it left still sends, removed on the branch the step it goes", () => {
    const ask = (trace: string, messages: unknown[], tools: string[]) => request(trace, { model: "m", system: [text("Be brief.")], tools: tools.map((name) => ({ name })), messages });
    const aside = [...say(1), { role: "user", content: [text("Say 1."), text("Aside.")] }];
    const events = [...ask("t1", say(1), ["Read", "Edit"]), ...ask("t2", say(2), ["Read", "Edit"]), ...ask("side", aside, ["Read"]), ...ask("t3", say(3), ["Read", "Edit"])];
    const at = layouts(events, shown, "stay");
    expect(at(3).rows.find(({ key }) => key === "thread:side/request/tools.Edit.0")).toMatchObject({ change: "removed", block: { name: "Edit" }, branch: { key: "branch:side" } });
    // The line it left sends it still, and gives it no version.
    expect(listed(at(3))).toContain("thread:t1/request/tools.Edit.0 same");
    expect(listed(at(4))).toContain("thread:t1/request/tools.Edit.0 same");
    // It stays listed where it stood while the branch does, and goes with the branch.
    expect(listed(at(4)).filter((row) => row.startsWith("thread:side/request/tools"))).toEqual(["thread:side/request/tools.Edit.0 same"]);
    expect(listed(layouts(events, shown, "step")(4)).filter((row) => row.startsWith("thread:side/request/tools"))).toEqual(["thread:side/request/tools.Edit.0 removed"]);
  });

  it("lists a branch only while its requests are: the step after its last shows it removed, and later steps not at all", () => {
    const at = layouts(branched, shown, "step");
    expect(listed(at(3))).toContain("thread:side/message.1/content.1 added");
    const removed = at(4).rows.filter((row) => row.kind !== "fold" && row.change === "removed");
    expect(removed.map(({ key }) => key)).toEqual(["side", "side/request", "side/request/http", "side/message.1", "thread:side/message.1/content.1"]);
    expect(removed.at(-1)).toMatchObject({ block: { key: "content.1" } });
    // What a row shows is searched, taken away or not.
    expect(createSearch()(at(4).every.rows, /Aside/g).count).toBe(1);
    expect(at(5).every.rows.map(({ key }) => key)).not.toContain("side");
  });
});
