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
        "message.2": ["thread:t1/message.2/content.0"],
        response: ["t2/response/http", "thread:t1/message.3/content.0", "t2/response/stop reason", "t2/response/usage", "t2/response/fields"],
      },
    ]);
    expect(history(process).stepOf("title")).toBe(3);
    expect(history(process).stepOf("t3")).toBeUndefined();
  });

  it("keeps a block resent with something different as its item's next version, where the item stands, and stepping back undoes it", () => {
    const read = reader();
    const edited = [...process, ...request("t3", { ...main, system: [text("You are Claude Code, edited.")], messages: [hi, assistant(...hello), user(text("More."))] })];
    const after = read(edited);
    const system = after.segments[1]!.groups[0]!.items.find(({ key }) => key === "thread:t1/request/system.0")!;
    expect(system.versions.map(({ step, block }) => [step, block.parts])).toEqual([
      [2, [{ kind: "text", text: "You are Claude Code." }]],
      [5, [{ kind: "text", text: "You are Claude Code, edited." }]],
    ]);
    expect(arrived(after)[4]).toEqual({ request: ["t3/request/http"] });
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
    expect(arrived(read([...process, ...t3]))[4]).toMatchObject({ "message.4": ["thread:t1/message.4/content.0"] });
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
    expect(segments[1]!.groups.flatMap(({ items }) => items.map(({ key }) => key))).toEqual(["t2/request/http", "thread:t1/message.2/content.0"]);
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

// The events of `events`' first `count` exchanges.
function exchangesUpTo(events: RecordedEvent[], count: number): RecordedEvent[] {
  const traces = [...new Set(events.map(({ trace_id }) => trace_id))].slice(0, count);
  return events.filter(({ trace_id }) => traces.includes(trace_id));
}
