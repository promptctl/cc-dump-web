import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { createFormatter } from "../format/format.ts";
import { createHistory, type History } from "./history.ts";
import { rowIndex } from "./position.ts";

const timestamp = "2026-11-15T14:00:00.000Z";
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const request = (trace_id: string, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: [] },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
const reply = (trace_id: string, content: unknown[]): RecordedEvent[] => [
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
        "message.0": ["thread:probe/message.0/content.0"],
        response: ["probe/response/http", "thread:probe/message.1/content.0", "probe/response/stop reason", "probe/response/usage", "probe/response/fields"],
      },
      {
        request: ["t1/request/http", "thread:t1/request/parameters", "thread:t1/request/tools", "thread:t1/request/system.0"],
        "message.0": ["thread:t1/message.0/content.0"],
        // The reply is the thread's next message.
        response: ["t1/response/http", "thread:t1/message.1/content.0", "t1/response/stop reason", "t1/response/usage", "t1/response/fields"],
      },
      {
        request: ["title/request/http", "thread:title/request/parameters", "thread:title/request/system.0"],
        "message.0": ["thread:title/message.0/content.0"],
        response: ["title/response/http", "thread:title/message.1/content.0", "title/response/stop reason", "title/response/usage", "title/response/fields"],
      },
      // The second turn resends the first, its reply included, and the system prompt and tools: only what is new is its.
      {
        request: ["t2/request/http"],
        "message.2": ["thread:t2/message.2/content.0"],
        response: ["t2/response/http", "thread:t2/message.3/content.0", "t2/response/stop reason", "t2/response/usage", "t2/response/fields"],
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
    const system = after.segments[1]!.groups[0]!.items.find(({ key }) => key === "thread:t1/request/system.0")!;
    expect(system.versions.map(({ step, block }) => [step, block.parts])).toEqual([
      [2, [{ kind: "text", form: "markdown", text: "You are Claude Code." }]],
      [5, [{ kind: "text", form: "markdown", text: "You are Claude Code, edited." }]],
    ]);
    expect(arrived(after)[4]).toEqual({ request: ["t3/request/http"], "message.4": ["thread:t3/message.4/content.0"] });
    // Read without the last step, the history is as it was before it.
    expect(read(exchangesUpTo(edited, 4)).segments).toEqual(history(process).segments);
    // A history once returned is never changed by a later fold.
    expect(after.segments[1]!.groups[0]!.items.find(({ key }) => key === "thread:t1/request/system.0")!.versions).toHaveLength(2);
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
    const rows = ["t1", "t1/request", "t1/request/http", "t1/user", "t1/response"];
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
});

// Branches, shaped as a recording made through the app has them (dump-design-ajl.m1g): after `process`'s second turn,
// t2 (step 4), a side question resends it with its reply and asks its own; a compaction resends t2's messages without
// its reply, its last message given the summary instruction; and the thread's next turn resends t2 with its reply.
const more = [hi, assistant(...hello), user(text("More."))];
const answered = [...more, assistant(text("More hello."))];
const btw = [...request("btw", { ...main, messages: [...answered, user(text("Aside?"))] }), ...reply("btw", [text("Aside.")])];
const compact = [...request("compact", { ...main, messages: [hi, assistant(...hello), user(text("More."), text("Summarize."))] }), ...reply("compact", [text("Summary.")])];
const t3 = [...request("t3", { ...main, messages: [...answered, user(text("Again."))] }), ...reply("t3", [text("Again hello.")])];
// Every key of a thread's main line that has more than one version.
const versioned = ({ segments }: History) =>
  segments.flatMap(({ groups }) => groups.flatMap(({ items }) => items.filter(({ key, versions }) => key.startsWith("thread:") && versions.length > 1).map(({ key }) => key)));
const keysAt = ({ segments }: History, step: number) => segments[step - 1]!.groups.flatMap(({ items }) => items.map(({ key }) => key));

describe("branches", () => {
  it("keeps a side question on the thread until the thread's next turn leaves it out, then makes it a branch of its own", () => {
    const asked = history([...process, ...btw]);
    expect(keysAt(asked, 5)).toContain("thread:btw/message.4/content.0");
    const after = history([...process, ...btw, ...t3]);
    expect(keysAt(after, 5)).toEqual(["btw/request/http", "thread:btw/message.4/content.0", "btw/response/http", "thread:btw/message.5/content.0", "btw/response/stop reason", "btw/response/usage", "btw/response/fields"]);
    expect(after.segments[4]!.branch).toEqual({ key: "branch:btw", from: 4 });
    // The turn's message and reply are the thread's own, not versions of the question's.
    expect(keysAt(after, 6)).toContain("thread:t3/message.4/content.0");
    expect(versioned(after)).toEqual([]);
    expect([...after.branches]).toEqual([["branch:btw", 5]]);
  });

  it("makes a compaction a branch, and the thread goes on past it with nothing of the thread changed", () => {
    const after = history([...process, ...compact, ...t3]);
    expect(keysAt(after, 5)).toEqual([
      "compact/request/http",
      "thread:compact/message.2/content.1",
      "compact/response/http",
      "thread:compact/message.3/content.0",
      "compact/response/stop reason",
      "compact/response/usage",
      "compact/response/fields",
    ]);
    expect(keysAt(after, 6)).toContain("thread:t3/message.4/content.0");
    expect(after.segments[5]!.branch).toBeUndefined();
    expect(versioned(after)).toEqual([]);
  });

  it("puts twins, two requests that send the same first message, on lines of their own", () => {
    const task = user(text("Find the longest word."));
    const agent = { model: "m", system: [text("You are an agent.")], tools: [{ name: "Read", input_schema: {} }] };
    const after = history([
      ...request("s1", { ...agent, messages: [task] }),
      ...reply("s1", [text("A.")]),
      ...request("s2", { ...agent, messages: [task] }),
      ...reply("s2", [text("B.")]),
      ...request("s3", { ...agent, messages: [task, assistant(text("A.")), user(text("Read."))] }),
      ...request("s4", { ...agent, messages: [task, assistant(text("B.")), user(text("Read."))] }),
    ]);
    expect(keysAt(after, 2)).toContain("thread:s2/message.1/content.0");
    expect(keysAt(after, 3)).toContain("thread:s3/message.2/content.0");
    expect(keysAt(after, 4)).toContain("thread:s4/message.2/content.0");
    expect(versioned(after)).toEqual([]);
  });

  it("makes a side request with the thread's first message and a system prompt of its own a branch, never a version of the thread's", () => {
    const side = [...request("side", { model: "m", system: [text("Is this a new topic?")], messages: [hi] }), ...reply("side", [text("Yes.")])];
    const after = history([...process, ...side, ...t3]);
    expect(keysAt(after, 5)).toEqual(expect.arrayContaining(["thread:side/request/system.0", "thread:side/message.1/content.0"]));
    expect(versioned(after)).toEqual([]);
  });

  it("reads exchanges as they arrive to what a full read of them gives, a branch decided again included", () => {
    const events = [...process, ...btw, ...compact, ...t3];
    const read = reader();
    for (let count = 1; count <= 7; count++) {
      const now = read(exchangesUpTo(events, count));
      const full = history(exchangesUpTo(events, count));
      expect(now.segments).toEqual(full.segments);
      expect(now.branches).toEqual(full.branches);
    }
  });
});

// The events of `events`' first `count` exchanges.
function exchangesUpTo(events: RecordedEvent[], count: number): RecordedEvent[] {
  const traces = [...new Set(events.map(({ trace_id }) => trace_id))].slice(0, count);
  return events.filter(({ trace_id }) => traces.includes(trace_id));
}
