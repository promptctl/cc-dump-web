import { traceIds } from "@cc-dump/log/testing";
import type { TraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { createFormatter } from "../format/format.ts";
import { createHistory, sameFields, type History } from "./history.ts";
import { rowIndex } from "./position.ts";

const timestamp = "2026-11-15T14:00:00.000Z";
// The traces of the exchanges below, by label.
const id = traceIds("a1", "a2", "btw", "c1", "compact", "other", "probe", "s1", "s2", "s3", "s4", "side", "t1", "t2", "t3", "title");
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const request = (trace_id: TraceId, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: [] },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
const reply = (trace_id: TraceId, content: unknown[]): RecordedEvent[] => [
  { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { timestamp, trace_id, type: "response_body", base64: base64({ id: `msg_${trace_id}`, type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) },
  { timestamp, trace_id, type: "response_trailers", headers: [] },
  { timestamp, trace_id, type: "end", outcome: "ok" },
];
const text = (text: string) => ({ type: "text", text });
const user = (...content: unknown[]) => ({ role: "user", content });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
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
  ...request(id.probe, { model: "m", messages: [user(text("quota"))] }),
  ...reply(id.probe, [text("ok")]),
  ...request(id.t1, { ...main, messages: [hi] }),
  ...reply(id.t1, hello),
  ...request(id.title, { model: "m", system: [text("Write a title.")], messages: [user(text("Title for: Hi."))] }),
  ...reply(id.title, [text("Greeting")]),
  ...request(id.t2, { ...main, messages: [hi, assistant(...hello), user(text("More."))] }),
  ...reply(id.t2, [text("More hello.")]),
];

describe("history", () => {
  it("adds each exchange to one conversation, each thread found by its first message, and resending adds nothing", () => {
    expect(arrived(history(process))).toEqual([
      {
        request: [`${id.probe}/request/http`, `thread:${id.probe}/request/parameters`],
        response: [`${id.probe}/response/http`, `${id.probe}/response/stop reason`, `${id.probe}/response/usage`, `${id.probe}/response/fields`],
        "message.0": [`thread:${id.probe}/message.0/content.0`],
        reply: [`thread:${id.probe}/message.1/content.0`],
      },
      {
        request: [`${id.t1}/request/http`, `thread:${id.t1}/request/parameters`],
        response: [`${id.t1}/response/http`, `${id.t1}/response/stop reason`, `${id.t1}/response/usage`, `${id.t1}/response/fields`],
        tools: [`thread:${id.t1}/tools/tools.Read.0`],
        system: [`thread:${id.t1}/system/system.0`],
        "message.0": [`thread:${id.t1}/message.0/content.0`],
        // The reply is the thread's next message.
        reply: [`thread:${id.t1}/message.1/content.0`],
      },
      {
        request: [`${id.title}/request/http`, `thread:${id.title}/request/parameters`],
        response: [`${id.title}/response/http`, `${id.title}/response/stop reason`, `${id.title}/response/usage`, `${id.title}/response/fields`],
        system: [`thread:${id.title}/system/system.0`],
        "message.0": [`thread:${id.title}/message.0/content.0`],
        reply: [`thread:${id.title}/message.1/content.0`],
      },
      // The second turn resends the first, its reply included, and the system prompt and tools: only what is new is its.
      {
        request: [`${id.t2}/request/http`],
        response: [`${id.t2}/response/http`, `${id.t2}/response/stop reason`, `${id.t2}/response/usage`, `${id.t2}/response/fields`],
        "message.2": [`thread:${id.t2}/message.2/content.0`],
        reply: [`thread:${id.t2}/message.3/content.0`],
      },
    ]);
    expect(history(process).stepOf(id.title)).toBe(3);
    expect(history(process).stepOf(id.t3)).toBeUndefined();
  });

  it("keeps a block resent with something different as its item's next version, where the item stands, and stepping back undoes it", () => {
    const read = reader();
    // The next turn carries the thread on with its system prompt edited in place.
    const turn = [hi, assistant(...hello), user(text("More.")), assistant(text("More hello.")), user(text("Again."))];
    const edited = [...process, ...request(id.t3, { ...main, system: [text("You are Claude Code, edited.")], messages: turn })];
    const after = read(edited);
    const system = () => after.segments[1]!.groups.flatMap(({ items }) => items).find(({ key }) => key === `thread:${id.t1}/system/system.0`)!;
    expect(system().versions.map(({ step, block }) => [step, block?.parts])).toEqual([
      [2, [{ kind: "text", form: "markdown", text: "You are Claude Code." }]],
      [5, [{ kind: "text", form: "markdown", text: "You are Claude Code, edited." }]],
    ]);
    expect(arrived(after)[4]).toEqual({ request: [`${id.t3}/request/http`], "message.4": [`thread:${id.t3}/message.4/content.0`] });
    // Read without the last step, the history is as it was before it.
    expect(read(exchangesUpTo(edited, 4)).segments).toEqual(history(process).segments);
    // A history once returned is never changed by a later fold.
    expect(system().versions).toHaveLength(2);
  });

  it("folds again from the exchange still streaming to what a full read of it gives", () => {
    const read = reader();
    const t3 = [...request(id.t3, { ...main, messages: [hi, assistant(...hello), user(text("More.")), assistant(text("More hello.")), user(text("Again."))] }), ...reply(id.t3, [text("Again hello.")])];
    read([...process, ...t3.slice(0, 2)]);
    read([...process, ...t3.slice(0, 5)]);
    expect(read([...process, ...t3]).segments).toEqual(history([...process, ...t3]).segments);
    expect(arrived(read([...process, ...t3]))[4]).toMatchObject({ "message.4": [`thread:${id.t3}/message.4/content.0`] });
  });

  it("compares a reply with the block the next request resends as it is resent: the fields the API reported and the client drops do not change it", () => {
    const thinking = { type: "thinking", thinking: "", signature: "c2ln" };
    const read = { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } };
    const events = [
      ...request(id.t1, { ...main, messages: [hi] }),
      ...reply(id.t1, [{ ...thinking, estimated_tokens: 50 }, { ...read, caller: { type: "direct" } }]),
      ...request(id.t2, { ...main, messages: [hi, assistant(thinking, { ...read, cache_control: { type: "ephemeral" } }), user({ type: "tool_result", tool_use_id: "toolu_1", content: "a" })] }),
    ];
    const { segments } = history(events);
    const versions = segments[0]!.groups.flatMap(({ items }) => items).filter(({ key }) => key.startsWith(`thread:${id.t1}/message.1/`));
    expect(versions.map(({ versions }) => versions.length)).toEqual([1, 1]);
    // A field the client sends back is compared.
    const changed = history([...events.slice(0, 7), ...request(id.t2, { ...main, messages: [hi, assistant(thinking, { ...read, caller: { type: id.other } })] })]);
    expect(changed.segments[0]!.groups.flatMap(({ items }) => items).find(({ key }) => key === `thread:${id.t1}/message.1/content.1`)!.versions).toHaveLength(2);
  });

  it("says of a version what it rewrote: nothing for a reply's block a request took away and a later one resends as a client does, the block it was for one sent with other content", () => {
    const read = { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } };
    // The second turn drops the reply's tool use and what followed it, carrying the thread on; the third sends the tool
    // use again, without the field the API reported of it.
    const versions = (again: unknown) =>
      history([
        ...request(id.t1, { ...main, messages: [hi] }),
        ...reply(id.t1, [text("Hello."), { ...read, caller: { type: "direct" } }, text("Done.")]),
        ...request(id.t2, { ...main, messages: [hi, assistant(text("Hello.")), user(text("More."))] }),
        ...request(id.t3, { ...main, messages: [hi, assistant(text("Hello."), again), user(text("More.")), user(text("Again."))] }),
      ])
        .segments[0]!.groups.flatMap(({ items }) => items)
        .find(({ key }) => key === `thread:${id.t1}/message.1/content.1`)!.versions;
    expect(versions(read)).toMatchObject([{ step: 1, reply: true, rewrote: undefined }, { step: 2, block: undefined }, { step: 3, reply: false, rewrote: undefined }]);
    const rewritten = versions({ ...read, input: { file_path: "/b" } });
    expect(rewritten.map(({ step }) => step)).toEqual([1, 2, 3]);
    expect(rewritten[2]).toMatchObject({ rewrote: rewritten[0]!.block });
  });

  it("adds nothing for a reply that quotes a reminder when it is resent, since an assistant's text is never split", () => {
    const quoting = [text("It said:\n<system-reminder>\nUse the tool.\n</system-reminder>")];
    const { segments } = history([
      ...request(id.t1, { ...main, messages: [hi] }),
      ...reply(id.t1, quoting),
      ...request(id.t2, { ...main, messages: [hi, assistant(...quoting), user(text("Go on."))] }),
    ]);
    expect(segments[1]!.groups.flatMap(({ items }) => items.map(({ key }) => key))).toEqual([`${id.t2}/request/http`, `thread:${id.t2}/message.2/content.0`]);
  });

  it("names a thread's places apart from every row of the exchange that began it", () => {
    const rows = [id.t1, `${id.t1}/request/http`, `${id.t1}/response/http`, `${id.t1}/tools`, `${id.t1}/system`, `${id.t1}/message.0`, `${id.t1}/reply`];
    const indexOf = (key: string) => (rows.includes(key) ? rows.indexOf(key) : undefined);
    for (const { groups } of history(process).segments) {
      for (const { key } of groups.flatMap(({ items }) => items).filter(({ key }) => key.startsWith("thread:"))) expect(rowIndex(key, indexOf)).toBeUndefined();
    }
  });

  it("keeps the exchanges of a request not yet read as its own, and finds its thread once it is", () => {
    const partial = request(id.t2, { ...main, messages: [hi, assistant(...hello)] }).slice(0, 1);
    const read = reader();
    expect(arrived(read([...process.slice(0, 14), ...partial]))[2]).toEqual({ request: [`${id.t2}/request/http`] });
    expect(arrived(read([...process.slice(0, 14), ...request(id.t2, { ...main, messages: [hi, assistant(...hello)] })]))[2]).toEqual({ request: [`${id.t2}/request/http`] });
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
const btw = [...request(id.btw, { ...main, messages: [...answered, user(text("Aside?"))] }), ...reply(id.btw, [text("Aside.")])];
const compact = [
  ...request(id.compact, { ...main, messages: [hi, assistant(...hello), user(text("More."), text("Summarize."))] }),
  ...reply(id.compact, [text("<analysis>\nThought.\n</analysis>\n\n<summary>\n1. Said hello.\n</summary>\n")]),
];
const t3 = [...request(id.t3, { ...main, messages: [...answered, user(text("Again."))] }), ...reply(id.t3, [text("Again hello.")])];
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
    expect(keysAt(after, 5)).toEqual([`${id.btw}/request/http`, `${id.btw}/response/http`, `${id.btw}/response/stop reason`, `${id.btw}/response/usage`, `${id.btw}/response/fields`, `thread:${id.btw}/message.4/content.0`, `thread:${id.btw}/message.5/content.0`]);
    // The turn's message and reply are its own, not versions of the question's.
    expect(keysAt(after, 6)).toEqual(expect.arrayContaining([`thread:${id.t3}/message.4/content.0`, `thread:${id.t3}/message.5/content.0`]));
    expect(versioned(after)).toEqual([]);
  });

  it("has a compaction stand after the turn before the one whose message it rewrites, and the thread that begins with its summary hang on its reply", () => {
    const continued = request(id.c1, { ...main, messages: [user(text("This session is being continued.\nSummary:\n1. Said hello.\nGo on."))] });
    const after = history([...process, ...compact, ...t3, ...continued]);
    // The compaction resends t1 whole and t2's message with the instruction, never t2's reply: its message is its own.
    expect(afters(after).slice(4)).toEqual([follows(2), follows(4), { step: 5, on: "block", key: `thread:${id.compact}/message.3/content.0`, as: "thread" }]);
    expect(keysAt(after, 5)).toEqual([
      `${id.compact}/request/http`,
      `${id.compact}/response/http`,
      `${id.compact}/response/stop reason`,
      `${id.compact}/response/usage`,
      `${id.compact}/response/fields`,
      `thread:${id.compact}/message.2/content.0`,
      `thread:${id.compact}/message.2/content.1`,
      `thread:${id.compact}/message.3/content.0`,
    ]);
    expect(keysAt(after, 6)).toContain(`thread:${id.t3}/message.4/content.0`);
    // A thread hung on a block is a history of its own: every block it sends is its item.
    expect(keysAt(after, 7)).toEqual([`${id.c1}/request/http`, `thread:${id.c1}/request/parameters`, `thread:${id.c1}/tools/tools.Read.0`, `thread:${id.c1}/system/system.0`, `thread:${id.c1}/message.0/content.0`]);
    expect(versioned(after)).toEqual([]);
  });

  it("hangs each subagent on the Agent tool's call that launched it, twins on the calls of their one prompt in order, and a probe of one on the last", () => {
    const call = (id: string, prompt: string) => ({ type: "tool_use", id, name: "Agent", input: { description: "Look", prompt, subagent_type: "Explore" } });
    const task = user(text("<system-reminder>\nBe brief.\n</system-reminder>\nFind the longest word.\n"));
    const agent = { model: "m", system: [text("You are an agent.")], tools: [{ name: "Read", input_schema: {} }] };
    const after = history([
      ...request(id.t1, { ...main, messages: [hi] }),
      ...reply(id.t1, [text("On it."), call("toolu_1", "Find the longest word."), call("toolu_2", "Find the longest word."), call("toolu_3", "Count the words.")]),
      ...request(id.s1, { ...agent, messages: [task] }),
      ...reply(id.s1, [text("A.")]),
      ...request(id.s2, { ...agent, messages: [task] }),
      ...reply(id.s2, [text("B.")]),
      ...request(id.other, { ...agent, messages: [user(text("Count the words."))] }),
      ...request(id.s3, { ...agent, messages: [task, assistant(text("A.")), user(text("Read."))] }),
      ...request(id.s4, { ...agent, messages: [task, assistant(text("B.")), user(text("Read."))] }),
      ...request(id.probe, { ...agent, messages: [task] }),
      ...reply(id.probe, [text("Reading.")]),
    ]);
    const under = (content: number) => ({ step: 1, on: "block", key: `thread:${id.t1}/message.1/content.${content}`, as: "nest" });
    expect(afters(after)).toEqual([undefined, under(1), under(2), under(3), follows(2), follows(3), under(2)]);
    // Twins send the same first message and are each a history of their own.
    expect(keysAt(after, 3)).toEqual(expect.arrayContaining([`thread:${id.s2}/message.0/content.0.0`, `thread:${id.s2}/message.0/content.0.1`, `thread:${id.s2}/message.1/content.0`]));
    expect(keysAt(after, 5)).toContain(`thread:${id.s3}/message.2/content.0`);
    expect(keysAt(after, 6)).toContain(`thread:${id.s4}/message.2/content.0`);
    expect(versioned(after)).toEqual([]);
  });

  it("hangs a request that sends a thread's first message with a system prompt of its own on nothing, a history of its own", () => {
    const side = [...request(id.side, { model: "m", system: [text("Is this a new topic?")], messages: [hi] }), ...reply(id.side, [text("Yes.")])];
    const after = history([...process, ...side, ...t3]);
    expect(afters(after).slice(4)).toEqual([undefined, follows(4)]);
    expect(keysAt(after, 5)).toEqual(expect.arrayContaining([`thread:${id.side}/system/system.0`, `thread:${id.side}/message.0/content.0`, `thread:${id.side}/message.1/content.0`]));
    expect(versioned(after)).toEqual([]);
  });

  it("gives an item a version by the step that sends it differently, which comes after the item's version on that step's path, never a sibling's", () => {
    // Two side questions after t1, each with a system prompt of its own, the first answered, and the thread's turn after
    // t2, with the thread's.
    const aside = (trace: TraceId, prompt: string) => request(trace, { ...main, system: [text(prompt)], messages: [hi, assistant(...hello), user(text("Aside?"))] });
    const after = history([...process, ...aside(id.a1, "Answer briefly."), ...reply(id.a1, [text("Aside.")]), ...t3, ...aside(id.a2, "Answer at length.")]);
    expect(afters(after).slice(4)).toEqual([follows(2), follows(4), follows(2)]);
    const { versions } = itemAt(after, `thread:${id.t1}/system/system.0`);
    expect(versions.map(({ step, previous }) => [step, previous])).toEqual([
      [2, undefined],
      [5, 0],
      [7, 0],
    ]);
    // Each rewrote the thread's prompt, not the other question's; and the turn, which sends the thread's, gave it none.
    expect(versions[1]).toMatchObject({ rewrote: versions[0]!.block });
    expect(versions[2]).toMatchObject({ rewrote: versions[0]!.block });
    // The questions' messages are alike and each its own item, since neither is on the other's path.
    expect(keysAt(after, 5)).toContain(`thread:${id.a1}/message.2/content.0`);
    expect(keysAt(after, 7)).toContain(`thread:${id.a2}/message.2/content.0`);
  });

  it("strikes what a step's path holds and it does not send, at that step, for the steps that follow it alone", () => {
    const edit = { name: "Edit", input_schema: {} };
    const first = [...request(id.t1, { ...main, tools: [...main.tools, edit], messages: [hi] }), ...reply(id.t1, hello)];
    const turn = (trace: TraceId, tools: unknown[], said: string) => request(trace, { ...main, tools, messages: [hi, assistant(...hello), user(text(said))] });
    const after = history([...first, ...turn(id.t2, main.tools, "More."), ...turn(id.a1, [...main.tools, edit], "Aside?")]);
    expect(afters(after)).toEqual([undefined, follows(1), follows(1)]);
    // The question's path is t1 alone, which holds the tool, so the tool is as it was to it.
    expect(itemAt(after, `thread:${id.t1}/tools/tools.Edit.0`).versions).toMatchObject([{ step: 1 }, { step: 2, block: undefined, previous: 0 }]);
  });

  it("numbers a system's message by the speaker's it stands before, so dropping one moves no place after it", () => {
    const reminder = { role: "system", content: "Stay on task." };
    const after = history([
      ...request(id.t1, { ...main, messages: [hi, reminder] }),
      ...reply(id.t1, hello),
      ...request(id.t2, { ...main, messages: [hi, assistant(...hello), user(text("More."))] }),
    ]);
    expect(afters(after)).toEqual([undefined, follows(1)]);
    expect(keysAt(after, 2)).toEqual([`${id.t2}/request/http`, `thread:${id.t2}/message.2/content.0`]);
    expect(versioned(after)).toEqual([`thread:${id.t1}/message.1.system.0/content.0`]);
    expect(itemAt(after, `thread:${id.t1}/message.1.system.0/content.0`).versions).toMatchObject([{ step: 1 }, { step: 2, block: undefined }]);
  });

  it("returns the groups it returned before wherever a step read again changed nothing, as each event of a reply still arriving reads its step again", () => {
    const groupsOf = ({ segments }: History) => segments.flatMap(({ formatted, groups }) => groups.map((group) => [`${formatted.exchange.trace_id}/${group.key}`, group] as const));
    // The groups that are not the objects they were once the last request, read before its reply, is read with it.
    const changed = (events: RecordedEvent[], trace: TraceId) => {
      const read = reader();
      const before = new Map(groupsOf(read(events)));
      const after = read([...events, ...reply(trace, [text("Done.")])]);
      return { after, keys: groupsOf(after).flatMap(([key, group]) => (before.get(key) === group ? [] : [key])) };
    };
    const first = [...request(id.t1, { ...main, messages: [hi] }), ...reply(id.t1, hello)];
    // A turn that rewrites the prompt, a version of the first's item: what its reply brought is its own groups' alone.
    const turn = changed([...first, ...request(id.t2, { ...main, system: [text("You are an agent.")], messages: [hi, assistant(...hello), user(text("More."))] })], id.t2);
    expect(turn.keys).toEqual([`${id.t2}/response`, `${id.t2}/reply`]);
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
