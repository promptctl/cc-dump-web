import type { RecordedEvent } from "@cc-dump/proxy/format";
import { beforeEach, describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { categories, type Block, type Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import type { Part } from "../format/parts.ts";
import type { Visibility } from "../settings.ts";
import { createHistory } from "./history.ts";
import { adjacent, createSearch } from "./search.ts";
import { useView, view } from "./state.ts";
import { blockOf, blocksOf, categoryOf, clockTime, compact, createLayout, describeSize, estimateHeight, isGone, isOpen, lastOf, markOf, modelName, nestsOf, pastOf, preview, seconds, sectionsStartOpen, setStartsOpen, showsOpen, sizeOf, startsExpanded, summaryOf, type BlockRow, type ForkRow, type NestRow, type Opened, type Row, type SetRow } from "./rows.ts";

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
// Every category listed, a block a line, and a set its one line.
const shown = Object.fromEntries(categories.map((category) => [category, "compact"])) as Record<Category, Visibility>;
// The same with the tools' set open, so each tool definition is listed.
const listing = { ...shown, tools: "expanded" } as const;
const dialogue = { ...shown, tools: "hidden", system: "hidden", parameters: "hidden", usage: "hidden", http: "hidden", thinking: "hidden" } as const;

// The layout at each step of `events`, as the view lays them out.
function layouts(events: RecordedEvent[], visibility: Record<Category, Visibility> = shown) {
  const history = createHistory()(createFormatter()(exchanges(events)));
  const layOut = createLayout(visibility);
  return (step: number, current?: string, opened: Opened = {}) => layOut(history, step, current, opened);
}
// The block's row at `key` among a layout's.
const blockAt = ({ rows }: { rows: Row[] }, key: string) => rows.find((row): row is BlockRow => row.kind === "block" && row.key === key)!;
const listed = ({ rows }: { rows: Row[] }) => rows.map((row) => (row.kind === "block" ? `${row.key} ${row.change}` : row.key));

describe("layout", () => {
  it("lays out the conversation at a step: each step's exchange, then what first arrived with it, the step shown's added", () => {
    const at = layouts(turns(2));
    expect(listed(at(1))).toEqual([
      "t1",
      "t1/request/http added",
      "thread:t1/request/parameters added",
      "t1/tools",
      "t1/system",
      "thread:t1/system/system.0 added",
      "t1/message.0",
      "thread:t1/message.0/content.0 added",
    ]);
    // The second turn resends the first: only its HTTP and its new message are its, and the first's rows are unchanged.
    expect(listed(at(2)).slice(8)).toEqual(["t2", "t2/request/http added", "t2/message.1", "thread:t2/message.1/content.0 added"]);
    expect(at(2).rows.slice(0, 8).every((row) => row.kind !== "block" || row.change === "same")).toBe(true);
    expect(at(2).rows.filter((row) => row.kind !== "block").map((row) => row.change)).toEqual(["same", "same", "same", "same", "added", "added"]);
    // A block as it arrived has no past, at its step or after; a step of 0 shows nothing.
    expect(at(2).rows.every((row) => row.kind !== "block" || (pastOf(row).length === 0 && markOf(row) === row.change))).toBe(true);
    expect(at(0).rows).toEqual([]);
  });

  it("marks a block a step rewrote as changed, and keeps what the step rewrote as its past at every step after", () => {
    // The second turn edits the system prompt in place, carrying the thread on; the third resends it as the second left it.
    const turn = (trace: string, count: number) => request(trace, { model: "m", system: [text("Be briefer.")], tools: [{ name: "Read" }], messages: say(count) });
    const at = layouts([...turns(1), ...turn("t2", 2), ...turn("t3", 3)]);
    const system = (step: number) => blockAt(at(step), "thread:t1/system/system.0");
    const rewrite = { step: 2, change: "changed", before: { parts: [{ kind: "text", text: "Be brief." }] }, after: { parts: [{ kind: "text", text: "Be briefer." }] } };
    expect([system(2).change, blockOf(system(2))]).toMatchObject(["changed", rewrite.after]);
    expect(pastOf(system(2))).toMatchObject([rewrite]);
    // The step after left it as it was, and its past and its mark still say the rewrite.
    expect([system(3).change, blockOf(system(3))]).toMatchObject(["same", rewrite.after]);
    expect(pastOf(system(3))).toEqual(pastOf(system(2)));
    expect([system(2), system(3)].map(markOf)).toEqual(["changed", "changed"]);
    // At the step it arrived, the item is what it was then, with no past.
    expect([system(1).change, blockOf(system(1))]).toMatchObject(["added", rewrite.before]);
    expect(pastOf(system(1))).toEqual([]);
    expect([1, 2, 3].map((step) => lastOf(system(step)))).toEqual([undefined, pastOf(system(2))[0], pastOf(system(2))[0]]);
  });

  it("marks exactly the tool a request changed, dropped or added, the rest unchanged, and a prompt block dropped as removed the step it goes", () => {
    const tool = (name: string, description: string) => ({ name, description, input_schema: {} });
    const messages = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "user", content: [text(`Say ${index}.`)] }));
    const turn = (trace: string, count: number, tools: unknown[], system: string[]) => request(trace, { model: "m", system: system.map(text), tools, messages: messages(count) });
    const at = layouts(
      [
        ...turn("t1", 1, [tool("Read", "Reads"), tool("Edit", "Edits"), tool("Bash", "Runs")], ["Be brief.", "Mind the tools."]),
        ...turn("t2", 2, [tool("Read", "Reads"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
        ...turn("t3", 3, [tool("Read", "Reads"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
        ...turn("t4", 4, [tool("Read", "Reads"), tool("Edit", "Edits"), tool("Bash", "Runs a command"), tool("Grep", "Searches")], ["Be brief."]),
      ],
      listing,
    );
    const prompt = (step: number) => listed(at(step)).filter((row) => /\/(tools|system)\//.test(row));
    // Each tool is its own item, lined up by its name: Bash changed, Edit gone, Grep come, Read as it was.
    expect(prompt(2)).toEqual([
      "thread:t1/tools/tools.Read.0 same",
      "thread:t1/tools/tools.Edit.0 removed",
      "thread:t1/tools/tools.Bash.0 changed",
      "thread:t1/system/system.0 same",
      "thread:t1/system/system.1 removed",
      "thread:t2/tools/tools.Grep.0 added",
    ]);
    const edit = (step: number) => blockAt(at(step), "thread:t1/tools/tools.Edit.0");
    // Its row shows the block it was.
    expect(blockOf(edit(2))).toMatchObject({ name: "Edit" });
    expect(isGone(edit(2))).toBe(true);
    // Taken away, it stays listed where it stood, the step after leaving it and every other row as they were; its past
    // and its mark still say it went.
    expect(prompt(3)).toEqual([
      "thread:t1/tools/tools.Read.0 same",
      "thread:t1/tools/tools.Edit.0 same",
      "thread:t1/tools/tools.Bash.0 same",
      "thread:t1/system/system.0 same",
      "thread:t1/system/system.1 same",
      "thread:t2/tools/tools.Grep.0 same",
    ]);
    expect([isGone(edit(3)), pastOf(edit(3)), markOf(edit(3))]).toEqual([true, [{ step: 2, change: "removed" }], "removed"]);
    // Offered again, it is there again, added, with both steps in its past.
    expect(prompt(4).filter((row) => !row.endsWith("same"))).toEqual(["thread:t1/tools/tools.Edit.0 added"]);
    expect([isGone(edit(4)), pastOf(edit(4))]).toEqual([false, [{ step: 2, change: "removed" }, { step: 4, change: "added" }]]);
    expect([2, 3, 4].map((step) => lastOf(edit(step)))).toEqual([2, 3, 4].map((step) => pastOf(edit(step)).at(-1)));
  });

  it("marks a block a step took away and a later one sends with other content as rewritten, from the block it was", () => {
    const tool = (name: string, description: string) => ({ name, description, input_schema: {} });
    const turn = (trace: string, count: number, tools: unknown[]) => request(trace, { model: "m", tools, messages: say(count) });
    const at = layouts(
      [...turn("t1", 1, [tool("Read", "Reads"), tool("Edit", "Edits")]), ...turn("t2", 2, [tool("Read", "Reads")]), ...turn("t3", 3, [tool("Read", "Reads"), tool("Edit", "Edits a file")])],
      listing,
    );
    const edit = (step: number) => blockAt(at(step), "thread:t1/tools/tools.Edit.0");
    expect([edit(1), edit(2), edit(3)].map(({ change }) => change)).toEqual(["added", "removed", "changed"]);
    // The step that took it away showed the block it was, which is what the rewrite is read against.
    expect(blockOf(edit(2))).toBe(blockOf(edit(1)));
    expect(blockOf(edit(3))).not.toEqual(blockOf(edit(1)));
    expect(pastOf(edit(3))).toEqual([{ step: 2, change: "removed" }, { step: 3, change: "changed", before: blockOf(edit(1)), after: blockOf(edit(3)) }]);
  });

  it("marks a block a request stops sending inside a message it resends removed, the step it goes", () => {
    const at = layouts([
      ...request("t1", { model: "m", messages: [...say(1), { role: "user", content: [text("Say 1."), text("Mind it.")] }] }),
      ...request("t2", { model: "m", messages: [...say(3)] }),
    ]);
    const minded = blockAt(at(2), "thread:t1/message.1/content.1");
    expect([minded.change, blockOf(minded)]).toMatchObject(["removed", { parts: [{ text: "Mind it." }] }]);
    expect(listed(at(2))).toContain("thread:t1/message.1/content.0 same");
    expect(listed(at(2))).toContain("thread:t2/message.2/content.0 added");
  });

  it("leaves out a hidden category's blocks, and a group with none left, and puts a row not listed at the row listed before it", () => {
    const at = layouts(turns(2), dialogue);
    expect(listed(at(2))).toEqual(["t1", "t1/message.0", "thread:t1/message.0/content.0 same", "t2", "t2/message.1", "thread:t2/message.1/content.0 added"]);
    const { keys } = at(2);
    expect(keys.at(keys.indexOf("t1/request/http")!)).toBe("t1");
    expect(keys.at(keys.indexOf("thread:t1/system/system.0")!)).toBe("t1");
    expect(keys.at(keys.indexOf("t2/request/http")!)).toBe("t2");
    expect(keys.indexOf("t3")).toBeUndefined();
  });

  it("keeps every row, listed or not, in order, as one object while no block of it changed, and the keys while no row moved", () => {
    const at = layouts(turns(3), { ...shown, tools: "hidden" });
    const first = at(3);
    const everyKey = first.every.rows.map(({ key }) => key);
    expect(everyKey).toContain("thread:t1/tools/tools.Read.0");
    expect(everyKey.map((key) => first.every.keys.indexOf(key))).toEqual(everyKey.map((_, index) => index));
    const withCurrent = at(3, "thread:t1/tools/tools.Read.0");
    expect(withCurrent.every).toBe(first.every);
    expect(withCurrent.keys).not.toBe(first.keys);
    expect(at(3).keys).not.toBe(withCurrent.keys);
    expect(at(3).keys).toBe(at(3).keys);
    // Another step is other rows.
    expect(at(2).every).not.toBe(first.every);
  });

  it("keeps the keys while what a row shows changes and no row moves, as while a block streams", () => {
    const events = turns(3);
    const layOut = createLayout(shown);
    // Two formatters make the same rows of other block objects.
    const first = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    const again = layOut(createHistory()(createFormatter()(exchanges(events))), 3, undefined, {});
    expect(again.every).not.toBe(first.every);
    expect(again.keys).toBe(first.keys);
  });

  it("keeps every row as one object at a step while a later step arrives, though it takes away a block the step shows", () => {
    const ask = (trace: string, count: number, tools: string[]) => request(trace, { model: "m", tools: tools.map((name) => ({ name })), messages: say(count) });
    const events = [...ask("t1", 1, ["Read", "Edit"]), ...ask("t2", 2, ["Read"])];
    const [format, fold, layOut] = [createFormatter(), createHistory(), createLayout(listing)];
    const after = (count: number, step: number) => layOut(fold(format(exchanges(events.slice(0, count)))), step, undefined, {});
    const first = after(3, 1);
    expect(after(events.length, 1).every).toBe(first.every);
    // At the step that took it away, the row shows the same block, as one taken away, and every row is made again.
    const [was, gone] = [first, after(events.length, 2)].map((layout) => blockAt(layout, "thread:t1/tools/tools.Edit.0"));
    expect([blockOf(gone!) === blockOf(was!), isGone(was!), isGone(gone!)]).toEqual([true, false, true]);
  });

  it("gives other keys when a hidden block arrives, though the rows listed are the same, since where a hidden row stands moved", () => {
    const t1 = turns(1);
    const messages = [0, 1].map((index) => ({ role: "user", content: [text(`Say ${index}.`)] }));
    const t2 = request("t2", { model: "m", system: [text("Be brief."), text("Mind the tools.")], tools: [{ name: "Read" }], messages });
    const history = createHistory();
    const format = createFormatter();
    const layOut = createLayout({ ...shown, user: "hidden", system: "hidden", parameters: "hidden", usage: "hidden", http: "hidden" });
    const before = layOut(history(format(exchanges([...t1, ...t2.slice(0, 1)]))), 2, undefined, {});
    const after = layOut(history(format(exchanges([...t1, ...t2]))), 2, undefined, {});
    expect(listed(after)).toEqual(listed(before));
    expect(after.every.rows.map(({ key }) => key)).toContain("thread:t2/system/system.1");
    expect(after.keys).not.toBe(before.keys);
  });

  it("starts the sections under a block's headings open in what the user or the assistant said or thought, and closed in what was written for the model", () => {
    const block = (category: Category, injected: boolean): Block => ({ category, name: "n", parts: [], ...(injected ? { injected: true as const } : {}) });
    expect((["user", "assistant", "thinking", "system", "tools"] as const).map((category) => sectionsStartOpen(block(category, false)))).toEqual([true, true, true, false, false]);
    expect((["user", "assistant"] as const).map((category) => sectionsStartOpen(block(category, true)))).toEqual([false, false]);
  });

  it("starts a block's row as its category's level says, and what the harness injected, a block a step took away or a hidden category's block that is the search's current match collapsed", () => {
    const block = (category: Category, injected: boolean): Block => ({ category, name: "n", parts: [], ...(injected ? { injected: true as const } : {}) });
    const [said, reminder, tools] = [block("user", false), block("user", true), block("tools", false)];
    const row = (side: Block, gone = false): BlockRow => {
      const shown = { ...side, key: "c" };
      const versions: BlockRow["versions"] = [{ step: 1, block: shown, reply: false, rewrote: undefined, previous: undefined }, ...(gone ? [{ step: 2, block: undefined, was: shown, previous: 0 }] : [])];
      return { kind: "block", key: "k", change: gone ? "removed" : "added", versions, at: versions.length - 1, set: undefined, depth: 0, dimmed: false };
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

  it("lists a hidden category's blocks at neither level but the search's current match", () => {
    const keys = (visibility: Record<Category, Visibility>, current?: string) => listed(layouts(turns(1), visibility)(1, current, { "t1/tools": true }));
    expect(keys({ ...shown, system: "expanded" })).toEqual(keys(shown));
    expect(keys({ ...shown, tools: "hidden" })).not.toContain("thread:t1/tools/tools.Read.0 added");
    // In the set the step to it opened.
    expect(keys({ ...shown, tools: "hidden" }, "thread:t1/tools/tools.Read.0")).toContain("thread:t1/tools/tools.Read.0 added");
  });

  // The virtualizer keeps a row's measured height by this key, so a height measured open is not read for the row closed.
  it("measures a block's row by its key and whether it shows open, and keeps the keys while neither changes", () => {
    const system = "thread:t1/system/system.0";
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

describe("a set", () => {
  const tool = (name: string, description: string) => ({ name, description, input_schema: {} });
  const turn = (trace: string, count: number, tools: unknown[]) => request(trace, { model: "m", tools, messages: say(count) });
  // Three tools; the second step rewrites Bash and takes Edit away, the third leaves them so, the fourth takes Bash away.
  const events = [
    ...turn("t1", 1, [tool("Read", "Reads"), tool("Edit", "Edits"), tool("Bash", "Runs")]),
    ...turn("t2", 2, [tool("Read", "Reads"), tool("Bash", "Runs a command")]),
    ...turn("t3", 3, [tool("Read", "Reads"), tool("Bash", "Runs a command")]),
    ...turn("t4", 4, [tool("Read", "Reads")]),
  ];
  const tools = ["Read", "Edit", "Bash"].map((name) => `thread:t1/tools/tools.${name}.0`);
  const setAt = ({ rows }: { rows: Row[] }) => rows.find((row): row is SetRow => row.kind === "set")!;
  const toolsListed = (layout: { rows: Row[] }) => layout.rows.filter((row) => row.kind === "block" && blockOf(row).category === "tools").map(({ key }) => key);

  it("is one line that stands for its blocks at compact, and lists them under it at expanded or once the reader opens it", () => {
    const compact = layouts(events)(1);
    expect(toolsListed(compact)).toEqual([]);
    expect(setAt(compact)).toMatchObject({ key: "t1/tools", title: "tools", change: "added" });
    // Its blocks are still the search's, each naming the line a step to it opens, and stand where its line does.
    expect(compact.every.rows.flatMap((row) => (row.kind === "block" && row.set !== undefined ? [[row.key, row.set]] : []))).toEqual(tools.map((key) => [key, "t1/tools"]));
    expect(tools.map((key) => compact.keys.indexOf(key))).toEqual(tools.map(() => compact.keys.indexOf("t1/tools")));
    expect(toolsListed(layouts(events, listing)(1))).toEqual(tools);
    // The reader's choice outranks how the level starts it, either way; the line is listed both ways.
    expect(toolsListed(layouts(events)(1, undefined, { "t1/tools": true }))).toEqual(tools);
    const closed = layouts(events, listing)(1, undefined, { "t1/tools": false });
    expect([toolsListed(closed), setAt(closed).key]).toEqual([[], "t1/tools"]);
  });

  it("holds the search's current match while closed, and at a hidden level lists its line only over that match", () => {
    expect(toolsListed(layouts(events)(1, tools[1]))).toEqual([]);
    const hidden = layouts(events, { ...shown, tools: "hidden" });
    expect(hidden(1).rows.some(({ kind }) => kind === "set")).toBe(false);
    // Closed over the current match, the line is still listed, the control that opens it.
    expect(listed(hidden(1, tools[1])).filter((row) => row.includes("/tools"))).toEqual(["t1/tools"]);
    // Open at a hidden level, a set lists none but the current match.
    expect(toolsListed(hidden(1, tools[1], { "t1/tools": true }))).toEqual([tools[1]]);
  });

  describe("a step of the search into it", () => {
    const hidden = { ...shown, tools: "hidden" } as const;
    const pattern = /Runs/g;
    beforeEach(() => useView.setState(useView.getInitialState(), true));
    // The reader's step to the first match, Bash's description, at the levels `visibility`, as the view takes it.
    const step = (visibility: Record<Category, Visibility>) => {
      const layout = layouts(events, visibility)(1);
      const to = adjacent(createSearch()(layout.every.rows, pattern), undefined, { at: "start" }, "next", pattern, layout.every.keys);
      if (to === undefined) throw new Error(`no match for ${pattern} among the tools`);
      view.goTo(to, "t1");
    };
    const toggle = (visibility: Record<Category, Visibility>) => view.toggle("t1/tools", setStartsOpen("tools", visibility));
    // What the reader sees of the set at the levels `visibility`, with the choices and the current match they hold:
    // its line, if listed, open or closed as it draws, and the tools listed under it.
    const seen = (visibility: Record<Category, Visibility>) => {
      const { opened, search } = useView.getState();
      const layout = layouts(events, visibility)(1, search.current?.key, opened);
      const line = layout.rows.some(({ kind }) => kind === "set") ? (isOpen(opened, "t1/tools", setStartsOpen("tools", visibility)) ? "open" : "closed") : "none";
      return { line, tools: toolsListed(layout) };
    };

    for (const [level, visibility, open] of [
      ["compact", shown, tools],
      ["expanded", listing, tools],
      ["hidden", hidden, [tools[2]]],
    ] as const) {
      it(`opens it at ${level}; the reader's close takes the current match back into the closed line, and opening it lists the match again`, () => {
        step(visibility);
        expect(seen(visibility)).toEqual({ line: "open", tools: open });
        toggle(visibility);
        expect(seen(visibility)).toEqual({ line: "closed", tools: [] });
        toggle(visibility);
        expect(seen(visibility)).toEqual({ line: "open", tools: open });
      });
    }

    it("leaves the current match listed under an open line, its block open, when the level changes after a step into a set and a block that started open", () => {
      step(listing);
      // Whether the current match's block shows open at the levels `visibility`, so the description holding it is drawn.
      const drawn = (visibility: Record<Category, Visibility>) => {
        const { opened, search } = useView.getState();
        const key = search.current!.key;
        return showsOpen(blockAt(layouts(events, visibility)(1, key, opened), key), visibility, opened);
      };
      expect(drawn(listing)).toBe(true);
      expect(seen(shown)).toEqual({ line: "open", tools });
      expect(drawn(shown)).toBe(true);
      expect(seen(hidden)).toEqual({ line: "open", tools: [tools[2]] });
      expect(drawn(hidden)).toBe(true);
    });
  });

  it("says on its line how many blocks it holds, which, and how large, and the last thing a step did to one of them", () => {
    const at = layouts(events);
    const set = (step: number) => setAt(at(step));
    const size = (step: number) => blocksOf(set(step)).filter((row) => !isGone(row)).reduce((sum, row) => sum + sizeOf(blockOf(row)), 0);
    expect(categoryOf(set(1))).toBe("tools");
    expect(summaryOf(set(1))).toEqual({ count: 3, names: ["Read", "Edit", "Bash"], size: size(1), last: undefined, touched: 0 });
    // A block a step took away is no longer counted, named or sized, and is said; of two a step touched, the later in
    // the set's order is the last.
    expect(summaryOf(set(2))).toMatchObject({ count: 2, names: ["Read", "Bash"], size: size(2), last: { name: "Bash", event: { step: 2, change: "changed" } }, touched: 2 });
    expect(size(2)).toBeGreaterThan(0);
    expect(summaryOf(set(3))).toEqual(summaryOf(set(2)));
    expect(summaryOf(set(4))).toMatchObject({ count: 1, names: ["Read"], last: { name: "Bash", event: { step: 4, change: "removed" } }, touched: 2 });
  });

  it("is changed by the step that does anything to a block of it, and marked by the last thing a step did at every step after", () => {
    const at = layouts(events);
    const set = (step: number) => setAt(at(step));
    expect([1, 2, 3, 4].map((step) => set(step).change)).toEqual(["added", "changed", "same", "changed"]);
    expect([1, 2, 3, 4].map((step) => markOf(set(step)))).toEqual(["added", "changed", "changed", "changed"]);
    // A set no step touched since it arrived is marked as a row left as it was.
    expect(markOf(setAt(layouts(turns(2))(2)))).toBe("same");
  });

  // The row is rendered again only when a field of it is another value, so its fields are the history's own.
  it("is the same fields at a step while steps arrive that give none of its blocks a version", () => {
    const [format, fold, layOut] = [createFormatter(), createHistory(), createLayout(shown)];
    const all = turns(3);
    const after = (count: number) => setAt(layOut(fold(format(exchanges(all.slice(0, count)))), 1, undefined, {}));
    const [first, later] = [after(3), after(all.length)];
    expect(Object.entries(later).every(([name, value]) => (first as Record<string, unknown>)[name] === value)).toBe(true);
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
    const nested: Block = { category: "parameters", name: "parameters", parts: [{ kind: "fields", fields: [["model", '"m"'], ["stop", "null"], ["thinking", [["type", '"adaptive"'], ["list", [["0", "1"]]]]]] }] };
    expect(preview(nested)).toBe('model "m" thinking.type "adaptive" thinking.list.0 1');
    // A JSON value that is a null reads as one a field holds.
    expect(preview({ category: "http", name: "error", parts: [{ kind: "json", value: null }] })).toBe("");
    expect(preview({ category: "http", name: "error", parts: [{ kind: "json", value: 5 }] })).toBe("5");
    // Deep JSON reads as its leaves, cut where the line ends.
    const deep = { a: { b: { c: { d: Array.from({ length: 60 }, (_, index) => index) } } } };
    const line = preview({ category: "usage", name: "usage", parts: [{ kind: "json", value: deep }] });
    expect(line).toMatch(/^a\.b\.c\.d\.0 0 a\.b\.c\.d\.1 1 /);
    expect(line).toMatch(/^.{198,200}…$/u);
  });

  it("previews a block by its own preview when it has one, nothing when that holds nothing", () => {
    const reminder = "<system-reminder>\nContext left: 80%.\n</system-reminder>";
    const parts: Part[] = [{ kind: "text", form: "markdown", text: reminder }];
    expect(preview({ category: "user", name: "system reminder", parts, preview: [{ kind: "text", form: "markdown", text: "\nContext left: 80%.\n" }] })).toBe("Context left: 80%.");
    expect(preview({ category: "usage", name: "stop reason: end_turn", parts, preview: [{ kind: "fields", fields: [["stop_sequence", "null"]] }] })).toBe("");
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

const say = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "user", content: [text(`Say ${index}.`)] }));

// A reply, which ends its turn unless it says why else it stopped.
const reply = (trace_id: string, content: unknown[], stop_reason = "end_turn"): RecordedEvent[] => [
  { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { timestamp, trace_id, type: "response_body", base64: base64({ id: `msg_${trace_id}`, type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) },
  { timestamp, trace_id, type: "response_trailers", headers: [] },
  { timestamp, trace_id, type: "end", outcome: "ok" },
];
const user = (...content: unknown[]) => ({ role: "user", content });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const main = { model: "m", system: [text("Be brief.")], tools: [{ name: "Read" }] };
const hi = user(text("Hi."));
const rowAt = <Kind extends Row["kind"]>({ rows }: { rows: Row[] }, kind: Kind, key: string) => rows.find((row): row is Extract<Row, { kind: Kind }> => row.kind === kind && row.key === key)!;
const keysOf = ({ rows }: { rows: Row[] }) => rows.map(({ key }) => key);

describe("the column", () => {
  // Two turns, then two requests that each resend the second with its reply and say their own: a side question, with a
  // system prompt of its own, at step 3, and the thread's next turn at step 4, siblings after step 2.
  const more = [hi, assistant(text("Hello.")), user(text("More."))];
  const answered = [...more, assistant(text("More hello."))];
  const parted = [
    ...request("t1", { ...main, messages: [hi] }),
    ...reply("t1", [text("Hello.")]),
    ...request("t2", { ...main, messages: more }),
    ...reply("t2", [text("More hello.")]),
    ...request("aside", { ...main, system: [text("Answer briefly.")], messages: [...answered, user(text("Aside?"))] }),
    ...reply("aside", [text("Aside.")]),
    ...request("t3", { ...main, messages: [...answered, user(text("Again."))] }),
    ...reply("t3", [text("Again hello.")]),
  ];
  const fork = (layout: { rows: Row[] }): ForkRow => rowAt(layout, "fork", "t2/fork");

  it("lists one history: of the steps that part after one, the one the latest step stands under, below the line where they part", () => {
    const at = layouts(parted);
    const below = (step: number) => keysOf(at(step)).slice(keysOf(at(step)).indexOf("t2/fork") + 1);
    expect(below(3)).toEqual(["aside", "aside/request/http", "aside/response/http", "aside/response/stop reason", "aside/response/usage", "aside/response/fields", "aside/message.4", "thread:aside/message.4/content.0", "aside/reply", "thread:aside/message.5/content.0"]);
    expect(below(4)).toEqual(["t3", "t3/request/http", "t3/response/http", "t3/response/stop reason", "t3/response/usage", "t3/response/fields", "t3/message.4", "thread:t3/message.4/content.0", "t3/reply", "thread:t3/message.5/content.0"]);
    // A sibling's rows are in neither list, so the search reads the column's alone.
    expect(at(4).every.rows.filter(({ key }) => key.includes("aside"))).toEqual([]);
    expect([3, 4].map((step) => createSearch()(at(step).every.rows, /Aside/g).count)).toEqual([2, 0]);
    // The rows above the line are the same rows whichever sibling is listed.
    const above = (step: number) => keysOf(at(step)).slice(0, keysOf(at(step)).indexOf("t2/fork"));
    expect(above(4)).toEqual(above(3));
    expect([...at(3).steps]).toEqual([1, 2, 3]);
    expect([...at(4).steps]).toEqual([1, 2, 4]);
  });

  it("lists on the line where histories part each sibling the recording holds there, by its step and what it says first, and the one listed", () => {
    const at = layouts(parted);
    const siblings = [
      { step: 3, preview: "Aside?" },
      { step: 4, preview: "Again." },
    ];
    // The line stands after the step's rows from the step on, before any sibling arrived, when none is listed.
    expect(keysOf(at(1))).not.toContain("t2/fork");
    expect(keysOf(at(2)).at(-1)).toBe("t2/fork");
    expect([2, 3, 4].map((step) => fork(at(step)))).toMatchObject([
      { siblings, shown: undefined, change: "same", depth: 0 },
      { siblings, shown: 3 },
      { siblings, shown: 4 },
    ]);
    // Its siblings are one array while they say the same, so its row is made again with the fields it had.
    expect(fork(at(4)).siblings).toBe(fork(at(3)).siblings);
    // Steps that hang on nothing are each listed, with no line between them.
    const apart = layouts([...request("probe", { model: "m", messages: [user(text("quota"))] }), ...request("t1", { ...main, messages: [hi] })]);
    expect(keysOf(apart(2)).filter((key) => !key.includes("/"))).toEqual(["probe", "t1"]);
  });

  it("shows of a block the version its own history gave it, never a sibling's", () => {
    const at = layouts(parted);
    const system = (step: number) => blockAt(at(step), "thread:t1/system/system.0");
    expect([system(3).change, pastOf(system(3))]).toMatchObject(["changed", [{ step: 3, change: "changed", after: { parts: [{ text: "Answer briefly." }] } }]]);
    // The turn sends the thread's prompt, which the question rewrote for itself alone.
    expect([system(4).change, pastOf(system(4)), markOf(system(4)), lastOf(system(4))]).toEqual(["same", [], "same", undefined]);
    expect(blockOf(system(4))).toMatchObject({ parts: [{ text: "Be brief." }] });
    expect(at(4).rows.filter((row) => row.change !== "same").every(({ key }) => key.startsWith("t3") || key.startsWith("thread:t3"))).toBe(true);
  });

  // A turn whose reply calls the Agent tool; the subagent, whose own reply calls it again; the subagent that launched;
  // the first subagent's next request; and the thread's next turn, with the call's result.
  const call = (id: string, prompt: string) => ({ type: "tool_use", id, name: "Agent", input: { description: "Look", prompt, subagent_type: "Explore" } });
  const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });
  const agent = { model: "m", system: [text("You are an agent.")], tools: [{ name: "Read" }] };
  const task = user(text("Find the longest word."));
  const nested = [
    ...request("t1", { ...main, messages: [hi] }),
    ...reply("t1", [text("On it."), call("toolu_1", "Find the longest word.")], "tool_use"),
    ...request("s1", { ...agent, messages: [task] }),
    ...reply("s1", [text("Looking."), call("toolu_2", "Count the words.")], "tool_use"),
    ...request("inner", { ...agent, messages: [user(text("Count the words."))] }),
    ...reply("inner", [text("Three.")]),
    ...request("s2", { ...agent, messages: [task, assistant(text("Looking."), call("toolu_2", "Count the words.")), user(result("toolu_2", "Three."))] }),
    ...reply("s2", [text("Done.")]),
    ...request("t2", { ...main, messages: [hi, assistant(text("On it."), call("toolu_1", "Find the longest word.")), user(result("toolu_1", "Done."))] }),
  ];
  const [outer, inner] = ["thread:t1/message.1/content.1/nest", "thread:s1/message.1/content.1/nest"];
  const nest = (layout: { rows: Row[] }, key = outer): NestRow => rowAt(layout, "nest", key);

  it("nests a subagent's rows under its Agent call, on one line that holds them closed until the reader opens it", () => {
    const at = layouts(nested, { ...dialogue, tools: "compact" });
    const above = ["t1", "t1/tools", "t1/message.0", "thread:t1/message.0/content.0", "t1/reply", "thread:t1/message.1/content.0", "thread:t1/message.1/content.1", outer];
    const below = ["t2", "t2/message.2", "thread:t2/message.2/content.0"];
    expect(keysOf(at(5))).toEqual([...above, ...below]);
    // What it holds is still the search's, and stands where its line does.
    const { every, keys } = at(5);
    expect(createSearch()(every.rows, /Three/g).count).toBe(2);
    expect(["s1", "thread:inner/message.1/content.0", "thread:s2/message.3/content.0"].map((key) => keys.at(keys.indexOf(key)!))).toEqual([outer, outer, outer]);
    // Open, it lists its subagent's steps in the order they arrived, one level in, between the call and its result; a
    // subagent's own subagent is a nest under its call there, closed.
    const open = at(5, undefined, { [outer]: true });
    const within = ["s1", "s1/tools", "s1/message.0", "thread:s1/message.0/content.0", "s1/reply", "thread:s1/message.1/content.0", "thread:s1/message.1/content.1", inner, "s2", "s2/message.2", "thread:s2/message.2/content.0", "s2/reply", "thread:s2/message.3/content.0"];
    expect(keysOf(open)).toEqual([...above, ...within, ...below]);
    expect(open.rows.map(({ depth }) => depth)).toEqual([...above.map(() => 0), ...within.map(() => 1), ...below.map(() => 0)]);
    const both = at(5, undefined, { [outer]: true, [inner]: true });
    expect(both.rows.filter(({ depth }) => depth === 2).map(({ key }) => key)).toEqual(["inner", "inner/tools", "inner/message.0", "thread:inner/message.0/content.0", "inner/reply", "thread:inner/message.1/content.0"]);
    // A nest open inside one that is closed lists nothing.
    expect(keysOf(at(5, undefined, { [inner]: true }))).toEqual([...above, ...below]);
    // The nests a row is inside, the innermost first, which a step of the search to it opens.
    const rows = every.rows;
    const nestsAt = (key: string) => nestsOf(rows, rows.findIndex((row) => row.key === key));
    expect(["thread:inner/message.1/content.0", inner, "s2", outer, "t2"].map(nestsAt)).toEqual([[inner, outer], [outer], [outer], [], []]);
  });

  it("says on a nest's line what it launched, how many steps it holds, and what it last did while its turn is not ended", () => {
    const at = layouts(nested);
    expect([2, 3, 4, 5].map((step) => nest(at(step)))).toMatchObject([
      { change: "added", type: "Explore", prompt: "Find the longest word.", count: 1, latest: { name: "tool_use: Agent" }, depth: 0 },
      { change: "changed", count: 1, latest: { name: "tool_use: Agent" } },
      { change: "changed", count: 2, latest: undefined },
      { change: "same", count: 2, latest: undefined },
    ]);
    expect(keysOf(at(1))).not.toContain(outer);
    expect(nest(at(3).every, inner)).toMatchObject({ change: "added", prompt: "Count the words.", count: 1, latest: undefined, depth: 1 });
    expect([2, 3, 4, 5].map((step) => markOf(nest(at(step))))).toEqual(["added", "changed", "changed", "same"]);
  });

  it("says what a subagent last did while a reply of its waits on a tool or is still coming, wherever its newest step stands", () => {
    // A subagent that reads, then searches, then hands its report back. While each tool runs the harness asks it what
    // it is doing, in a request that stands beside the step waiting on the tool: the first is answered and ends its
    // turn, the second the harness leaves when the subagent is done.
    const use = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
    const read = [task, assistant(use("toolu_2", "Read")), user(result("toolu_2", "A."))];
    const searched = [...read, assistant(use("toolu_3", "Grep")), user(result("toolu_3", "B."))];
    const asked = (messages: { role: string; content: unknown[] }[]) => [...messages.slice(0, -1), user(...messages.at(-1)!.content, text("What are you doing?"))];
    const working = [
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [call("toolu_1", "Find the longest word.")], "tool_use"),
      ...request("s1", { ...agent, messages: [task] }),
      ...reply("s1", [use("toolu_2", "Read")], "tool_use"),
      ...request("s2", { ...agent, messages: read }),
      ...reply("s2", [use("toolu_3", "Grep")], "tool_use"),
      ...request("asked", { ...agent, messages: asked(read) }),
      ...reply("asked", [text("Searching.")]),
      ...request("s3", { ...agent, messages: searched }),
      ...reply("s3", [use("toolu_4", "SubagentHandback")], "tool_use"),
      ...request("left", { ...agent, messages: asked(searched) }),
      { timestamp, trace_id: "left", type: "end", outcome: "aborted" } as const,
    ];
    const latest = (events: RecordedEvent[], step: number) => nest(layouts(events)(step), "thread:t1/message.1/content.0/nest").latest?.name;
    expect([2, 3, 4, 5, 6].map((step) => latest(working, step))).toEqual(["tool_use: Read", "tool_use: Grep", "tool_use: Grep", undefined, undefined]);
    // A reply still coming says what it has by now, the events of its exchange recorded so far. Before its first block
    // the line says what the subagent did last, the tool its request answers.
    const from = working.findIndex(({ trace_id }) => trace_id === "s2");
    const coming = (events: number) => latest(working.slice(0, from + events), 3);
    expect([3, 6].map(coming)).toEqual(["tool_use: Read", "tool_use: Grep"]);
    // The harness may ask while a reply is still coming: its asking, with no block of a reply yet, says nothing.
    expect(latest([...working.slice(0, from + 6), ...request("asked", { ...agent, messages: asked(read) })], 4)).toBe("tool_use: Grep");
  });

  it("puts the line where subagents of one call part first inside the call's nest", () => {
    // A second request with the subagent's first message hangs on the same call: a sibling of the first.
    const twice = [
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [call("toolu_1", "Find the longest word.")], "tool_use"),
      ...request("s1", { ...agent, messages: [task] }),
      ...reply("s1", [text("A.")]),
      ...request("s2", { ...agent, messages: [task] }),
    ];
    const at = layouts(twice, dialogue);
    const [line, parts] = ["thread:t1/message.1/content.0/nest", "thread:t1/message.1/content.0/fork"];
    expect(keysOf(at(3))).not.toContain(parts);
    const open = at(3, undefined, { [line]: true });
    expect(keysOf(open).slice(keysOf(open).indexOf(line))).toEqual([line, parts, "s2", "s2/message.0", "thread:s2/message.0/content.0"]);
    expect(rowAt(open, "fork", parts)).toMatchObject({ siblings: [{ step: 2, preview: "Find the longest word." }, { step: 3 }], shown: 3, depth: 1 });
    expect(rowAt(at(2, undefined, { [line]: true }), "fork", parts)).toMatchObject({ shown: 2 });
  });

  it("lists the thread that begins with a compaction's summary after one line under the summary, and dims the steps it carries on from", () => {
    const summary = "<analysis>\nThought.\n</analysis>\n\n<summary>\n1. Said hello.\n</summary>\n";
    const compacted = [
      ...request("probe", { model: "m", messages: [user(text("quota"))] }),
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [text("Hello.")]),
      ...request("t2", { ...main, messages: more }),
      ...reply("t2", [text("More hello.")]),
      ...request("compact", { ...main, messages: [hi, assistant(text("Hello.")), user(text("More."), text("Summarize."))] }),
      ...reply("compact", [text(summary)]),
      ...request("c1", { ...main, messages: [user(text("This session is being continued.\nSummary:\n1. Said hello.\nGo on."))] }),
    ];
    const at = layouts(compacted, dialogue);
    const line = "thread:compact/message.3/content.0/thread";
    // The compaction stands after the first turn, as the second does, whose message it rewrites.
    expect(keysOf(at(4))).not.toContain(line);
    expect(at(4).rows.some(({ dimmed }) => dimmed)).toBe(false);
    expect(keysOf(at(5)).slice(keysOf(at(5)).indexOf("compact"))).toEqual(["compact", "compact/message.2", "thread:compact/message.2/content.0", "thread:compact/message.2/content.1", "compact/reply", "thread:compact/message.3/content.0", line, "c1", "c1/message.0", "thread:c1/message.0/content.0"]);
    expect(rowAt(at(5), "thread", line)).toMatchObject({ change: "added", depth: 0, dimmed: false });
    const dimmed = at(5).rows.filter(({ dimmed }) => dimmed).map(({ key }) => key);
    expect(dimmed.filter((key) => !key.includes("/"))).toEqual(["t1", "compact"]);
    expect(dimmed).toContain("t1/fork");
    expect(dimmed.some((key) => key.includes("probe") || key.includes("c1"))).toBe(false);
  });
});
