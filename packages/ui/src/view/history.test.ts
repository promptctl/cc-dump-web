import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { createFormatter } from "../format/format.ts";
import { agentCall, assistant, launched, notification, reply, request, result, text, user } from "../../test/fixtures.ts";
import { createHistory, sameFields, type History } from "./history.ts";
import { rowIndex } from "./position.ts";

const main = { model: "m", system: [text("You are Claude Code.")], tools: [{ name: "Read", input_schema: {} }] };

// The history of `events`, as one formatter and one history read them, the way the view does, batch after batch.
function reader() {
  const format = createFormatter();
  const history = createHistory();
  return (events: RecordedEvent[]) => history(format(exchanges(events)));
}
const history = (events: RecordedEvent[]) => reader()(events);
// The keys of the items each step brought, by group.
const arrived = ({ segments }: History) =>
  segments.map(({ groups }) => Object.fromEntries(groups.filter(({ items }) => items.length > 0).map(({ key, items }) => [key, items.map(({ key }) => key)])));

// One process's exchanges, as a launched agent's recording has them: a quota probe, a turn, the title request, and the
// next turn, which resends the first with its reply.
const hi = user(text("Hi."));
const hello = [text("Hello.")];
const process: RecordedEvent[] = [
  ...request("probe", { model: "m", messages: [user(text("quota"))] }),
  ...reply("probe", [text("ok")]),
  ...request("t1", { ...main, messages: [hi] }),
  ...reply("t1", hello),
  ...request("title", { model: "m", system: [text("Write a title.")], messages: [user(text("Title for: Hi."))] }),
  ...reply("title", [text("Greeting")]),
  ...request("t2", { ...main, messages: [hi, assistant(...hello), user(text("More."))] }),
  ...reply("t2", [text("More hello.")]),
];

describe("history", () => {
  it("adds each exchange to one conversation, each thread found by its first message, and resending adds nothing", () => {
    expect(arrived(history(process))).toEqual([
      {
        request: ["probe/request/http", "thread:probe/request/parameters"],
        response: ["probe/response/http", "probe/response/stop reason", "probe/response/usage", "probe/response/fields"],
        "message.0": ["thread:probe/message.0/content.0"],
        reply: ["thread:probe/message.1/content.0"],
      },
      {
        request: ["t1/request/http", "thread:t1/request/parameters"],
        response: ["t1/response/http", "t1/response/stop reason", "t1/response/usage", "t1/response/fields"],
        tools: ["thread:t1/tools/tools.Read.0"],
        system: ["thread:t1/system/system.0"],
        "message.0": ["thread:t1/message.0/content.0"],
        // The reply is the thread's next message.
        reply: ["thread:t1/message.1/content.0"],
      },
      {
        request: ["title/request/http", "thread:title/request/parameters"],
        response: ["title/response/http", "title/response/stop reason", "title/response/usage", "title/response/fields"],
        system: ["thread:title/system/system.0"],
        "message.0": ["thread:title/message.0/content.0"],
        reply: ["thread:title/message.1/content.0"],
      },
      // The second turn resends the first, its reply included, and the system prompt and tools: only what is new is its.
      {
        request: ["t2/request/http"],
        response: ["t2/response/http", "t2/response/stop reason", "t2/response/usage", "t2/response/fields"],
        "message.2": ["thread:t2/message.2/content.0"],
        reply: ["thread:t2/message.3/content.0"],
      },
    ]);
    expect(history(process).stepOf("title")).toBe(3);
    expect(history(process).stepOf("t3")).toBeUndefined();
  });

  it("keeps a block resent with something different as its item's next version, where the item stands, and stepping back undoes it", () => {
    const read = reader();
    // The next turn carries the thread on with its system prompt edited in place.
    const turn = [hi, assistant(...hello), user(text("More.")), assistant(text("More hello.")), user(text("Again."))];
    const edited = [...process, ...request("t3", { ...main, system: [text("You are Claude Code, edited.")], messages: turn })];
    const after = read(edited);
    const system = () => after.segments[1]!.groups.flatMap(({ items }) => items).find(({ key }) => key === "thread:t1/system/system.0")!;
    expect(system().versions.map(({ step, block }) => [step, block?.parts])).toEqual([
      [2, [{ kind: "text", form: "markdown", text: "You are Claude Code." }]],
      [5, [{ kind: "text", form: "markdown", text: "You are Claude Code, edited." }]],
    ]);
    expect(arrived(after)[4]).toEqual({ request: ["t3/request/http"], "message.4": ["thread:t3/message.4/content.0"] });
    // Read without the last step, the history is as it was before it.
    expect(read(exchangesUpTo(edited, 4)).segments).toEqual(history(process).segments);
    // A history once returned is never changed by a later fold.
    expect(system().versions).toHaveLength(2);
  });

  it("folds again from the exchange still streaming to what a full read of it gives", () => {
    const read = reader();
    const t3 = [...request("t3", { ...main, messages: [hi, assistant(...hello), user(text("More.")), assistant(text("More hello.")), user(text("Again."))] }), ...reply("t3", [text("Again hello.")])];
    read([...process, ...t3.slice(0, 2)]);
    read([...process, ...t3.slice(0, 5)]);
    expect(read([...process, ...t3]).segments).toEqual(history([...process, ...t3]).segments);
    expect(arrived(read([...process, ...t3]))[4]).toMatchObject({ "message.4": ["thread:t3/message.4/content.0"] });
  });

  it("compares a reply with the block the next request resends as it is resent: the fields the API reported and the client drops do not change it", () => {
    const thinking = { type: "thinking", thinking: "", signature: "c2ln" };
    const read = { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } };
    const events = [
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [{ ...thinking, estimated_tokens: 50 }, { ...read, caller: { type: "direct" } }]),
      ...request("t2", { ...main, messages: [hi, assistant(thinking, { ...read, cache_control: { type: "ephemeral" } }), user({ type: "tool_result", tool_use_id: "toolu_1", content: "a" })] }),
    ];
    const { segments } = history(events);
    const versions = segments[0]!.groups.flatMap(({ items }) => items).filter(({ key }) => key.startsWith("thread:t1/message.1/"));
    expect(versions.map(({ versions }) => versions.length)).toEqual([1, 1]);
    // A field the client sends back is compared.
    const changed = history([...events.slice(0, 7), ...request("t2", { ...main, messages: [hi, assistant(thinking, { ...read, caller: { type: "other" } })] })]);
    expect(changed.segments[0]!.groups.flatMap(({ items }) => items).find(({ key }) => key === "thread:t1/message.1/content.1")!.versions).toHaveLength(2);
  });

  it("says of a version what it rewrote: nothing for a reply's block a request took away and a later one resends as a client does, the block it was for one sent with other content", () => {
    const read = { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } };
    // The second turn drops the reply's tool use and what followed it, carrying the thread on; the third sends the tool
    // use again, without the field the API reported of it.
    const versions = (again: unknown) =>
      history([
        ...request("t1", { ...main, messages: [hi] }),
        ...reply("t1", [text("Hello."), { ...read, caller: { type: "direct" } }, text("Done.")]),
        ...request("t2", { ...main, messages: [hi, assistant(text("Hello.")), user(text("More."))] }),
        ...request("t3", { ...main, messages: [hi, assistant(text("Hello."), again), user(text("More.")), user(text("Again."))] }),
      ])
        .segments[0]!.groups.flatMap(({ items }) => items)
        .find(({ key }) => key === "thread:t1/message.1/content.1")!.versions;
    expect(versions(read)).toMatchObject([{ step: 1, reply: true, rewrote: undefined }, { step: 2, block: undefined }, { step: 3, reply: false, rewrote: undefined }]);
    const rewritten = versions({ ...read, input: { file_path: "/b" } });
    expect(rewritten.map(({ step }) => step)).toEqual([1, 2, 3]);
    expect(rewritten[2]).toMatchObject({ rewrote: rewritten[0]!.block });
  });

  it("adds nothing for a reply that quotes a reminder when it is resent, since an assistant's text is never split", () => {
    const quoting = [text("It said:\n<system-reminder>\nUse the tool.\n</system-reminder>")];
    const { segments } = history([
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", quoting),
      ...request("t2", { ...main, messages: [hi, assistant(...quoting), user(text("Go on."))] }),
    ]);
    expect(segments[1]!.groups.flatMap(({ items }) => items.map(({ key }) => key))).toEqual(["t2/request/http", "thread:t2/message.2/content.0"]);
  });

  it("names a thread's places apart from every row of the exchange that began it", () => {
    const rows = ["t1", "t1/request/http", "t1/response/http", "t1/tools", "t1/system", "t1/message.0", "t1/reply"];
    const indexOf = (key: string) => (rows.includes(key) ? rows.indexOf(key) : undefined);
    for (const { groups } of history(process).segments) {
      for (const { key } of groups.flatMap(({ items }) => items).filter(({ key }) => key.startsWith("thread:"))) expect(rowIndex(key, indexOf)).toBeUndefined();
    }
  });

  it("keeps the exchanges of a request not yet read as its own, and finds its thread once it is", () => {
    const partial = request("t2", { ...main, messages: [hi, assistant(...hello)] }).slice(0, 1);
    const read = reader();
    expect(arrived(read([...process.slice(0, 14), ...partial]))[2]).toEqual({ request: ["t2/request/http"] });
    expect(arrived(read([...process.slice(0, 14), ...request("t2", { ...main, messages: [hi, assistant(...hello)] })]))[2]).toEqual({ request: ["t2/request/http"] });
  });

  it("says two objects say the same when they have the same fields with the same values, a field that holds undefined not standing for one the other lacks", () => {
    const block = {};
    expect(sameFields({ step: 1, block }, { block, step: 1 })).toBe(true);
    expect(sameFields({ step: 1, block }, { step: 1, block: {} })).toBe(false);
    expect(sameFields({ step: 1, block: undefined }, { step: 1, block: undefined })).toBe(true);
    expect(sameFields({ step: 1, block: undefined }, { step: 1, rewrote: block })).toBe(false);
    expect(sameFields({ step: 1 }, { step: 1, block: undefined })).toBe(false);
  });
});

// Requests that part ways, shaped as a recording made through the app has them (dump-design-ajl.m1g): after
// `process`'s second turn, t2 (step 4), a side question resends it with its reply and asks its own; a compaction
// resends t2's messages without its reply, its last message given the summary instruction; and the thread's next turn
// resends t2 with its reply.
const more = [hi, assistant(...hello), user(text("More."))];
const answered = [...more, assistant(text("More hello."))];
const btw = [...request("btw", { ...main, messages: [...answered, user(text("Aside?"))] }), ...reply("btw", [text("Aside.")])];
const compact = [
  ...request("compact", { ...main, messages: [hi, assistant(...hello), user(text("More."), text("Summarize."))] }),
  ...reply("compact", [text("<analysis>\nThought.\n</analysis>\n\n<summary>\n1. Said hello.\n</summary>\n")]),
];
const t3 = [...request("t3", { ...main, messages: [...answered, user(text("Again."))] }), ...reply("t3", [text("Again hello.")])];
// Every item of a thread's that has more than one version, by key.
const versioned = ({ segments }: History) =>
  segments.flatMap(({ groups }) => groups.flatMap(({ items }) => items.filter(({ key, versions }) => key.startsWith("thread:") && versions.length > 1).map(({ key }) => key)));
const keysAt = ({ segments }: History, step: number) => segments[step - 1]!.groups.flatMap(({ items }) => items.map(({ key }) => key));
const afters = ({ segments }: History) => segments.map(({ after }) => after);
const follows = (step: number) => ({ step, on: "step" });
const itemAt = ({ segments }: History, key: string) => segments.flatMap(({ groups }) => groups.flatMap(({ items }) => items)).find((item) => item.key === key)!;

describe("what a step stands after", () => {
  it("has a side question and the thread's next turn both stand after the turn they resend, each with its own message and reply", () => {
    const after = history([...process, ...btw, ...t3]);
    expect(afters(after)).toEqual([undefined, undefined, undefined, follows(2), follows(4), follows(4)]);
    expect(keysAt(after, 5)).toEqual(["btw/request/http", "btw/response/http", "btw/response/stop reason", "btw/response/usage", "btw/response/fields", "thread:btw/message.4/content.0", "thread:btw/message.5/content.0"]);
    // The turn's message and reply are its own, not versions of the question's.
    expect(keysAt(after, 6)).toEqual(expect.arrayContaining(["thread:t3/message.4/content.0", "thread:t3/message.5/content.0"]));
    expect(versioned(after)).toEqual([]);
  });

  it("has a compaction stand after the turn before the one whose message it rewrites, and the thread that begins with its summary hang on its reply", () => {
    const continued = request("c1", { ...main, messages: [user(text("This session is being continued.\nSummary:\n1. Said hello.\nGo on."))] });
    const after = history([...process, ...compact, ...t3, ...continued]);
    // The compaction resends t1 whole and t2's message with the instruction, never t2's reply: its message is its own.
    expect(afters(after).slice(4)).toEqual([follows(2), follows(4), { step: 5, on: "block", key: "thread:compact/message.3/content.0", as: "thread" }]);
    expect(keysAt(after, 5)).toEqual([
      "compact/request/http",
      "compact/response/http",
      "compact/response/stop reason",
      "compact/response/usage",
      "compact/response/fields",
      "thread:compact/message.2/content.0",
      "thread:compact/message.2/content.1",
      "thread:compact/message.3/content.0",
    ]);
    expect(keysAt(after, 6)).toContain("thread:t3/message.4/content.0");
    // A thread hung on a block is a history of its own: every block it sends is its item.
    expect(keysAt(after, 7)).toEqual(["c1/request/http", "thread:c1/request/parameters", "thread:c1/tools/tools.Read.0", "thread:c1/system/system.0", "thread:c1/message.0/content.0"]);
    expect(versioned(after)).toEqual([]);
  });

  it("records on each step whose it is, the agent a result or a notification ties to the call that launched it, the stops, the calls answered and waited on, and a side question", () => {
    const agent = { model: "m", system: [text("You are an agent.")], tools: [{ name: "Read", input_schema: {} }] };
    const task = user(text("Find the longest word."));
    const launch = assistant(text("On it."), agentCall("toolu_1", "Find the longest word.", "Explore"));
    const read = { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/a" } };
    const after = history([
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", launch.content, "tool_use"),
      ...request("s1", { ...agent, messages: [task] }, { agent: "a1" }),
      ...reply("s1", [read], "tool_use"),
      // The harness asks the waiting agent what it is doing, resending the waiting step with no result.
      ...request("probe", { ...agent, messages: [task, assistant(read), user(text("Describe your most recent action."))] }, { agent: "a1" }),
      ...reply("probe", [text("Reading.")]),
      ...request("t2", { ...main, messages: [hi, launch, user(result("toolu_1", [text(launched("a1"))]))] }),
      ...reply("t2", [text("Waiting.")]),
      ...request("s2", { ...agent, messages: [task, assistant(read), user(result("toolu_r", "words"))] }, { agent: "a1" }),
      ...reply("s2", [text("Longest.")]),
      // The notification, then resent by the next request as history, which is no second stop.
      ...request("t3", { ...main, messages: [hi, launch, user(result("toolu_1", [text(launched("a1"))])), assistant(text("Waiting.")), user(notification("a1", "completed", "toolu_1"))] }),
      ...reply("t3", [text("Done.")]),
      ...request("t4", { ...main, messages: [hi, launch, user(result("toolu_1", [text(launched("a1"))])), assistant(text("Waiting.")), user(notification("a1", "completed", "toolu_1")), assistant(text("Done.")), user(text("Thanks."))] }),
    ]);
    const wires = after.segments.map(({ wire }) => wire);
    expect(wires.map(({ level }) => level)).toEqual([{ kind: "main" }, { kind: "agent", id: "a1" }, { kind: "agent", id: "a1" }, { kind: "main" }, { kind: "agent", id: "a1" }, { kind: "main" }, { kind: "main" }]);
    expect(wires.map(({ opens }) => opens)).toEqual([undefined, { names: undefined, says: "Find the longest word." }, undefined, undefined, undefined, undefined, undefined]);
    const call = { found: true, key: "thread:t1/message.1/content.1", launches: { tool: "Agent", type: "Explore", prompt: "Find the longest word." } };
    expect(wires.map(({ ties }) => ties)).toEqual([[], [], [], [{ agent: "a1", call: "toolu_1", ...call }], [], [{ agent: "a1", call: "toolu_1", ...call }], []]);
    expect(wires.map(({ stops }) => stops)).toEqual([[], [], [], [], [], [{ agent: "a1", status: "completed" }], []]);
    expect(wires.map(({ waits, answers, side, did }) => [waits, answers, side, did?.name])).toEqual([
      [["toolu_1"], [], false, "tool_use: Agent"],
      [["toolu_r"], [], false, "tool_use: Read"],
      [[], [], true, "text"],
      [[], ["toolu_1"], false, "text"],
      [[], ["toolu_r"], false, "text"],
      [[], [], false, "text"],
      [[], [], false, undefined],
    ]);
    // A subagent's request is its level's own thread, never the main agent's, so nothing of it is a version of main's.
    expect(afters(after)).toEqual([undefined, undefined, follows(2), follows(1), follows(2), follows(4), follows(6)]);
    expect(versioned(after)).toEqual([]);
  });

  it("ties an agent by a result only as the answer of an Agent call on the step's reach, never by a result that quotes one", () => {
    const bash = { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "cat log" } };
    const after = history([
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [bash], "tool_use"),
      // A Bash result that prints an Agent call's result, and a result for a call no step on its reach makes.
      ...request("t2", { ...main, messages: [hi, assistant(bash), user(result("toolu_b", [text(launched("a1"))]))] }),
      ...request("t3", { ...main, messages: [user(text("Else.")), assistant(text("Ok.")), user(result("toolu_x", [text(launched("a2"))]))] }),
    ]);
    expect(after.segments.map(({ wire }) => [wire.answers, wire.ties])).toEqual([
      [[], []],
      [["toolu_b"], []],
      [["toolu_x"], []],
    ]);
  });

  it("states what a block says when it arrives as an item's new version, as when it arrives as a new item", () => {
    const after = history([
      ...request("t1", { ...main, messages: [hi, user(text("Wait."))] }),
      ...reply("t1", [text("Waiting.")]),
      // The next turn resends the turn before with the notification where its message held other text.
      ...request("t2", { ...main, messages: [hi, user(notification("a1", "completed")), assistant(text("Waiting.")), user(text("Go on."))] }),
    ]);
    expect(afters(after)).toEqual([undefined, follows(1)]);
    expect(versioned(after)).toEqual(["thread:t1/message.1/content.0"]);
    expect(after.segments.map(({ wire }) => wire.stops)).toEqual([[], [{ agent: "a1", status: "completed" }]]);
  });

  it("records on a level's first step the agent its parent header names, and what its first message says", () => {
    const ask = (trace: string, from: { agent: string; parent?: string }) => request(trace, { ...main, messages: [user(text(`I am ${from.agent}.`))] }, from);
    const after = history([...request("t1", { ...main, messages: [hi] }), ...ask("b", { agent: "b1" }), ...ask("g", { agent: "g1", parent: "b1" }), ...ask("g2", { agent: "g1", parent: "b1" })]);
    expect(after.segments.map(({ wire }) => wire.opens)).toEqual([undefined, { names: undefined, says: "I am b1." }, { names: "b1", says: "I am g1." }, undefined]);
  });

  it("hangs a request that sends a thread's first message with a system prompt of its own on nothing, a history of its own", () => {
    const side = [...request("side", { model: "m", system: [text("Is this a new topic?")], messages: [hi] }), ...reply("side", [text("Yes.")])];
    const after = history([...process, ...side, ...t3]);
    expect(afters(after).slice(4)).toEqual([undefined, follows(4)]);
    expect(keysAt(after, 5)).toEqual(expect.arrayContaining(["thread:side/system/system.0", "thread:side/message.0/content.0", "thread:side/message.1/content.0"]));
    expect(versioned(after)).toEqual([]);
  });

  it("gives an item a version by the step that sends it differently, which comes after the item's version on that step's path, never a sibling's", () => {
    // Two side questions after t1, each with a system prompt of its own, the first answered, and the thread's turn after
    // t2, with the thread's.
    const aside = (trace: string, prompt: string) => request(trace, { ...main, system: [text(prompt)], messages: [hi, assistant(...hello), user(text("Aside?"))] });
    const after = history([...process, ...aside("a1", "Answer briefly."), ...reply("a1", [text("Aside.")]), ...t3, ...aside("a2", "Answer at length.")]);
    expect(afters(after).slice(4)).toEqual([follows(2), follows(4), follows(2)]);
    const { versions } = itemAt(after, "thread:t1/system/system.0");
    expect(versions.map(({ step, previous }) => [step, previous])).toEqual([
      [2, undefined],
      [5, 0],
      [7, 0],
    ]);
    // Each rewrote the thread's prompt, not the other question's; and the turn, which sends the thread's, gave it none.
    expect(versions[1]).toMatchObject({ rewrote: versions[0]!.block });
    expect(versions[2]).toMatchObject({ rewrote: versions[0]!.block });
    // The questions' messages are alike and each its own item, since neither is on the other's path.
    expect(keysAt(after, 5)).toContain("thread:a1/message.2/content.0");
    expect(keysAt(after, 7)).toContain("thread:a2/message.2/content.0");
  });

  it("strikes what a step's path holds and it does not send, at that step, for the steps that follow it alone", () => {
    const edit = { name: "Edit", input_schema: {} };
    const first = [...request("t1", { ...main, tools: [...main.tools, edit], messages: [hi] }), ...reply("t1", hello)];
    const turn = (trace: string, tools: unknown[], said: string) => request(trace, { ...main, tools, messages: [hi, assistant(...hello), user(text(said))] });
    const after = history([...first, ...turn("t2", main.tools, "More."), ...turn("a1", [...main.tools, edit], "Aside?")]);
    expect(afters(after)).toEqual([undefined, follows(1), follows(1)]);
    // The question's path is t1 alone, which holds the tool, so the tool is as it was to it.
    expect(itemAt(after, "thread:t1/tools/tools.Edit.0").versions).toMatchObject([{ step: 1 }, { step: 2, block: undefined, previous: 0 }]);
  });

  it("numbers a system's message by the speaker's it stands before, so dropping one moves no place after it", () => {
    const reminder = { role: "system", content: "Stay on task." };
    const after = history([
      ...request("t1", { ...main, messages: [hi, reminder] }),
      ...reply("t1", hello),
      ...request("t2", { ...main, messages: [hi, assistant(...hello), user(text("More."))] }),
    ]);
    expect(afters(after)).toEqual([undefined, follows(1)]);
    expect(keysAt(after, 2)).toEqual(["t2/request/http", "thread:t2/message.2/content.0"]);
    expect(versioned(after)).toEqual(["thread:t1/message.1.system.0/content.0"]);
    expect(itemAt(after, "thread:t1/message.1.system.0/content.0").versions).toMatchObject([{ step: 1 }, { step: 2, block: undefined }]);
  });

  it("returns the groups it returned before wherever a step read again changed nothing, as each event of a reply still arriving reads its step again", () => {
    const groupsOf = ({ segments }: History) => segments.flatMap(({ formatted, groups }) => groups.map((group) => [`${formatted.exchange.trace_id}/${group.key}`, group] as const));
    // The groups that are not the objects they were once the last request, read before its reply, is read with it.
    const changed = (events: RecordedEvent[], trace: string) => {
      const read = reader();
      const before = new Map(groupsOf(read(events)));
      const after = read([...events, ...reply(trace, [text("Done.")])]);
      return { after, keys: groupsOf(after).flatMap(([key, group]) => (before.get(key) === group ? [] : [key])) };
    };
    const first = [...request("t1", { ...main, messages: [hi] }), ...reply("t1", hello)];
    // A turn that rewrites the prompt, a version of the first's item: what its reply brought is its own groups' alone.
    const turn = changed([...first, ...request("t2", { ...main, system: [text("You are an agent.")], messages: [hi, assistant(...hello), user(text("More."))] })], "t2");
    expect(turn.keys).toEqual(["t2/response", "t2/reply"]);
    expect(turn.after.segments[0]!.groups.find(({ key }) => key === "system")!.items[0]!.versions.map(({ step }) => step)).toEqual([1, 2]);
  });

  it("reads exchanges as they arrive to what a full read of them gives", () => {
    const events = [...process, ...btw, ...compact, ...t3];
    const read = reader();
    for (let count = 1; count <= 7; count++) expect(read(exchangesUpTo(events, count)).segments).toEqual(history(exchangesUpTo(events, count)).segments);
  });
});

// The events of `events`' first `count` exchanges.
function exchangesUpTo(events: RecordedEvent[], count: number): RecordedEvent[] {
  const traces = [...new Set(events.map(({ trace_id }) => trace_id))].slice(0, count);
  return events.filter(({ trace_id }) => traces.includes(trace_id));
}
