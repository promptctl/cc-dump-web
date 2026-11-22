import { exchanges, recordedAt } from "../testing.ts";
import type { Header, RecordedEvent } from "@cc-dump/proxy/format";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Block } from "./blocks.ts";
import { createFormatter, inputOf, type FormattedExchange } from "./format.ts";
import { doesNotFit, fieldValue } from "./parts.ts";

// Recorded events as the proxy writes them, with bodies in the shapes Claude Code and the Messages API put on the wire.
const timestamp = "2026-11-13T08:00:00.000Z";
const at = recordedAt(timestamp);
// A body recorded in two chunks, each encoded on its own as the proxy does, so padding falls mid-body.
const chunks = (bytes: Buffer) => [bytes.subarray(0, Math.ceil(bytes.length / 3)), bytes.subarray(Math.ceil(bytes.length / 3))].map((chunk) => chunk.toString("base64"));

function request(trace: string, body: unknown, { url = "/v1/messages?beta=true", method = "POST" } = {}): RecordedEvent[] {
  return [
    { ...at(trace), type: "request", method, url, http_version: "1.1", headers: [["Content-Type", "application/json"]] },
    ...chunks(Buffer.from(JSON.stringify(body))).map((base64): RecordedEvent => ({ ...at(trace), type: "request_body", base64 })),
    { ...at(trace), type: "request_trailers", headers: [] },
  ];
}

// A response's head and body, its trailers when `complete`, gzip- or br-encoded.
function response(trace: string, status: number, headers: Header[], bytes: Buffer, complete = true): RecordedEvent[] {
  return [
    { ...at(trace), type: "response", status, reason: "", http_version: "1.1", headers },
    ...chunks(bytes).map((base64): RecordedEvent => ({ ...at(trace), type: "response_body", base64 })),
    ...(complete ? [{ ...at(trace), type: "response_trailers", headers: [] } as RecordedEvent] : []),
  ];
}
const sse = (events: object[]) => events.map((data) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const streamed = (trace: string, events: object[], complete = true) =>
  response(trace, 200, [["Content-Type", "text/event-stream; charset=utf-8"], ["Content-Encoding", "gzip"]], gzipSync(sse(events)), complete);
const end = (trace: string): RecordedEvent => ({ ...at(trace), type: "end", outcome: "ok" });

const format = (events: RecordedEvent[]) => createFormatter()(exchanges(events));
const one = (events: RecordedEvent[]): FormattedExchange => {
  const [formatted, ...rest] = format(events);
  expect(rest).toEqual([]);
  return formatted!;
};
const lines = (blocks: Block[]) => blocks.map(({ category, name }) => `${category} ${name}`);
// A group's blocks, by its key: `request` and `response`, the exchange's own of each side; `tools`, `system` and
// `message.<i>`, what the request sends; `reply`, what the response says.
const group = ({ groups }: FormattedExchange, key: string) => groups.find((group) => group.key === key)!.blocks;
// What a response brought, where which group holds it is not what is tested: the exchange's own, then the reply.
const received = (formatted: FormattedExchange) => [...group(formatted, "response"), ...group(formatted, "reply")];

// The place of a block of the first message.
const firstMessage = { in: "message", index: 0 } as const;
const png = { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" };
const messageStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-2", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } } };
const messageDelta = { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 90 }, context_management: { applied_edits: [] } };

describe("fieldValue", () => {
  it("shows every value as its JSON, a string quoted, so no value reads as one of another type", () => {
    expect(fieldValue({ text: "1.50", number: 1.5, spelled: "null", none: null, flag: false, empty: {}, list: ["a", { b: 1 }] })).toEqual([
      ["text", '"1.50"'],
      ["number", "1.5"],
      ["spelled", '"null"'],
      ["none", "null"],
      ["flag", "false"],
      ["empty", "{}"],
      ["list", [["0", '"a"'], ["1", [["b", "1"]]]]],
    ]);
  });

  it("shows a string that is the JSON of an object or a list as its fields only when they show every byte of it, as received otherwise", () => {
    expect(fieldValue({ held: '{"device_id":"d1"}', spaced: '{"a": 1}', precise: '{"a":12345678901234567890}', twice: '{"a":1,"a":2}' })).toEqual([
      ["held", [["device_id", '"d1"']]],
      ["spaced", JSON.stringify('{"a": 1}')],
      ["precise", JSON.stringify('{"a":12345678901234567890}')],
      ["twice", JSON.stringify('{"a":1,"a":2}')],
    ]);
  });
});

describe("format", () => {
  it("shows every content block of a session with its category, the envelope, then what the request sends, then the reply", () => {
    const body = {
      model: "claude-fable-5-2",
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "omitted" },
      metadata: { user_id: '{"device_id":"d1","session_id":"s1"}' },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      stop_sequences: [],
      tools: [{ name: "Read", description: "Reads a file", input_schema: { type: "object" } }, { type: "web_search_20250305", max_uses: 2 }],
      system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture and this doc?" },
            { type: "image", source: png },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "Quarterly notes" }, title: "notes" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" },
            { type: "redacted_thinking", data: "ZW5jcnlwdGVk" },
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/q.png" } },
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "quadrants" } },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Q" }] },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Read 1 image" }, { type: "image", source: png }] }] },
        { role: "system", content: "Context left: 80%." },
      ],
    };
    const formatted = one([
      ...request("a", body),
      ...streamed("a", [
        messageStart,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Red and " } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "blue." } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "Bash", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":' } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"ls"}' } },
        { type: "content_block_stop", index: 2 },
        messageDelta,
        { type: "message_stop" },
      ]),
      end("a"),
    ]);

    // The envelope's two groups have no heading; what the request sends is headed by what it is or who speaks, and the
    // reply by the word an assistant's message resent has.
    expect(formatted.groups.map(({ key, title }) => [key, title])).toEqual([
      ["request", undefined],
      ["response", undefined],
      ["tools", "tools"],
      ["system", "system"],
      ["message.0", "user"],
      ["message.1", "assistant"],
      ["message.2", "user"],
      ["message.3.system.0", "system"],
      ["reply", "assistant"],
    ]);
    expect(lines(group(formatted, "request"))).toEqual(["http HTTP request", "parameters parameters", "parameters cache breakpoints: 1"]);
    expect(lines(group(formatted, "response"))).toEqual(["http HTTP response", "usage stop reason: tool_use", "usage usage", "usage message"]);
    expect(lines(group(formatted, "tools"))).toEqual(["tools Read", "tools web_search_20250305"]);
    // A text block is named for its type, as every other block is: its heading says who spoke.
    expect(lines(group(formatted, "system"))).toEqual(["system text"]);
    expect(lines(group(formatted, "message.0"))).toEqual(["user text", "user image", "user document"]);
    // A thinking block that holds no text, and a redacted one, are usage, sent or streamed.
    expect(lines(group(formatted, "message.1"))).toEqual([
      "usage thinking",
      "usage redacted_thinking",
      "assistant text",
      "tools tool_use: Read",
      "tools server_tool_use: web_search",
      "tools web_search_tool_result",
    ]);
    expect(lines(group(formatted, "message.2"))).toEqual(["tools tool_result"]);
    expect(lines(group(formatted, "message.3.system.0"))).toEqual(["system system reminder"]);
    expect(lines(group(formatted, "reply"))).toEqual(["usage thinking", "assistant text", "tools tool_use: Bash"]);

    // The content each shows: the image, the text document, the tool result's text and image, the streamed message.
    expect(group(formatted, "message.0")[1]!.parts).toEqual([{ id: "source", kind: "media", of: "image", source: png }]);
    expect(group(formatted, "message.0")[2]!.parts).toEqual([
      { id: "source", kind: "text", form: "verbatim", text: "Quarterly notes" },
      { kind: "rest", id: "source/unread", label: "source fields", fields: [["media_type", '"text/plain"']] },
      { kind: "rest", id: "unread", label: "fields", fields: [["title", '"notes"']] },
    ]);
    expect(group(formatted, "message.2")[0]!.parts).toEqual([
      { id: "0/text", kind: "text", form: "verbatim", text: "Read 1 image" },
      { id: "1/source", kind: "media", of: "image", source: png },
      { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", "toolu_1"]] },
    ]);
    const [thinking, text, toolUse] = group(formatted, "reply");
    const [, , usage, message] = group(formatted, "response");
    // A field of an event that nothing reads lands on the block the event builds: the thinking delta's estimate.
    expect(thinking!.parts).toEqual([
      { id: "thinking", kind: "text", form: "markdown", text: "" },
      { id: "signature", kind: "fields", fields: [["signature", "4 characters"]] },
      { kind: "rest", id: "unread", label: "fields", fields: [["estimated_tokens", "50"]] },
    ]);
    expect(text!.parts).toEqual([{ id: "text", kind: "text", form: "markdown", text: "Red and blue." }]);
    expect(toolUse!.parts).toContainEqual({ kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" });
    expect(usage!.parts).toEqual([{ id: "usage", kind: "fields", fields: [["input_tokens", "2"], ["output_tokens", "90"]] }]);
    expect(message!.parts).toEqual([{ kind: "rest", id: "unread", label: "fields", fields: expect.arrayContaining([["id", '"msg_1"'], ["context_management", [["applied_edits", "[]"]]]]) }]);
    // A parameter or a field this view does not name is shown with the rest, not dropped.
    // An object's members are the fields it holds, a list's named by index; a string that is the JSON of one, as
    // metadata.user_id is, holds its fields too; any other value, an empty object or list too, reads as its JSON.
    expect(group(formatted, "request")[1]!.parts).toEqual([
      {
        id: "parameters",
        kind: "fields",
        fields: [
          ["model", '"claude-fable-5-2"'],
          ["max_tokens", "32000"],
          ["thinking", [["type", '"adaptive"'], ["display", '"omitted"']]],
          ["metadata", [["user_id", [["device_id", '"d1"'], ["session_id", '"s1"']]]]],
          ["context_management", [["edits", [["0", [["type", '"clear_thinking_20251015"'], ["keep", '"all"']]]]]]],
          ["stop_sequences", "[]"],
        ],
      },
    ]);
    // A tool's description reads first, what else defines it after; a server tool is named by its type, not shown again.
    expect(group(formatted, "tools")[0]!.parts).toEqual([
      { id: "description", kind: "text", form: "markdown", text: "Reads a file" },
      { kind: "rest", id: "unread", label: "fields", fields: [["input_schema", [["type", '"object"']]]] },
    ]);
    expect(group(formatted, "tools")[1]!.parts).toEqual([{ kind: "rest", id: "unread", label: "fields", fields: [["max_uses", "2"]] }]);
    // The cache breakpoint is the request's, out of the block it was set on.
    expect(group(formatted, "system")[0]!.parts).toEqual([{ id: "text", kind: "text", form: "markdown", text: "You are Claude Code." }]);
    expect(group(formatted, "request")[2]!.parts).toEqual([{ id: "breakpoints", kind: "fields", fields: [["system.0", [["type", '"ephemeral"']]]] }]);
  });

  it("reads a thinking block that holds text as thinking, in a message and in the reply", () => {
    const thought = { type: "thinking", thinking: "The file is small.", signature: "c2ln" };
    const formatted = one([
      ...request("a", { model: "m", messages: [{ role: "assistant", content: [thought] }] }),
      ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify({ ...messageStart.message, content: [thought] }))),
    ]);
    expect(lines(group(formatted, "message.0"))).toEqual(["thinking thinking"]);
    expect(lines(group(formatted, "reply"))).toEqual(["thinking thinking"]);
    expect(group(formatted, "reply")[0]!.parts[0]).toEqual({ id: "thinking", kind: "text", form: "markdown", text: "The file is small." });
  });

  it("shows an exchange cut short with the exchange's own, where no reply stands", () => {
    const cut = (outcome: "aborted" | "stopped") => one([...request("a", { model: "m", messages: [] }), { ...at("a"), type: "end", outcome }]);
    expect(group(cut("aborted"), "response")).toEqual([{ key: "end", category: "http", name: "aborted", parts: [{ id: "end", kind: "text", form: "verbatim", text: "The agent left the exchange before it completed." }] }]);
    expect(group(cut("stopped"), "response")).toMatchObject([{ key: "end", category: "http", name: "stopped" }]);
    expect(group(cut("aborted"), "reply")).toEqual([]);
  });

  it("lifts the cache breakpoints out of the blocks into the request's, in the order the cache's prefix is built", () => {
    const breakpoint = { type: "ephemeral", ttl: "1h" };
    const shown = fieldValue(breakpoint);
    const formatted = one(
      request("a", {
        model: "m",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi." }, { type: "text", text: "Go.", cache_control: breakpoint }] },
          { role: "assistant", content: "Done." },
        ],
        system: [{ type: "text", text: "S", cache_control: breakpoint }],
        tools: [{ name: "Read", input_schema: {} }, { name: "Bash", input_schema: {}, cache_control: breakpoint }],
      }),
    );
    const request_ = group(formatted, "request");
    expect(request_.at(-1)).toEqual({
      key: "cache",
      category: "parameters",
      name: "cache breakpoints: 3",
      parts: [{ id: "breakpoints", kind: "fields", fields: [["tools.Bash.0", shown], ["system.0", shown], ["message.0/content.1", shown]] }],
      // Its line previews where they are.
      preview: [{ kind: "text", form: "verbatim", text: "tools.Bash.0  system.0  message.0/content.1" }],
    });
    // No block holds one, so a block resent with the breakpoint moved off it is the block it was.
    expect(group(formatted, "tools").map(({ parts }) => parts)).toEqual([
      [{ kind: "rest", id: "unread", label: "fields", fields: [["input_schema", "{}"]] }],
      [{ kind: "rest", id: "unread", label: "fields", fields: [["input_schema", "{}"]] }],
    ]);
    expect(group(formatted, "message.0")[1]!.parts).toEqual([{ id: "text", kind: "text", form: "markdown", text: "Go." }]);
    // What the request sends is its thread's, its parameters too; the breakpoints and its HTTP are its own.
    const places = (key: string) => group(formatted, key).map(({ key, place }) => [key, place]);
    expect(places("request")).toEqual([["http", undefined], ["parameters", { in: "parameters" }], ["cache", undefined]]);
    expect(places("tools")).toEqual([["tools.Read.0", { in: "tools" }], ["tools.Bash.0", { in: "tools" }]]);
    expect(places("system")).toEqual([["system.0", { in: "system" }]]);
    expect(group(formatted, "message.1").map(({ place }) => place)).toEqual([{ in: "message", index: 1 }]);
    expect(formatted.messages).toBe(2);
  });

  it("numbers the speakers' messages among themselves, a system-role message standing before one and moving none", () => {
    const system = (text: string) => ({ role: "system", content: text });
    const messages = [system("First."), { role: "user", content: "Hi." }, system("Second."), system("Third."), { role: "assistant", content: "Hello." }, { role: "narrator", content: "Later." }, system("Last.")];
    const formatted = one([...request("a", { model: "m", messages: [...messages, { role: "user", content: [{ type: "text", text: "Go.", cache_control: { type: "ephemeral" } }] }, { role: "system", content: [{ type: "text", text: "End.", cache_control: { type: "ephemeral" } }] }] })]);
    // A role this view does not know is a speaker's, so the messages after it keep their places.
    expect(formatted.groups.filter(({ key }) => key.startsWith("message")).map(({ key, title, blocks }) => [key, title, blocks[0]!.place])).toEqual([
      ["message.0.system.0", "system", { in: "system message", before: 0, index: 0 }],
      ["message.0", "user", { in: "message", index: 0 }],
      ["message.1.system.0", "system", { in: "system message", before: 1, index: 0 }],
      ["message.1.system.1", "system", { in: "system message", before: 1, index: 1 }],
      ["message.1", "assistant", { in: "message", index: 1 }],
      ["message.2", "message", { in: "message", index: 2 }],
      ["message.3.system.0", "system", { in: "system message", before: 3, index: 0 }],
      ["message.3", "user", { in: "message", index: 3 }],
      ["message.4.system.0", "system", { in: "system message", before: 4, index: 0 }],
    ]);
    // The reply's index is the count of the speakers' messages, and a breakpoint is named by its message's key.
    expect(formatted.messages).toBe(4);
    expect(group(formatted, "request")[2]!.preview).toEqual([{ kind: "text", form: "verbatim", text: "message.3/content.0  message.4.system.0/content.0" }]);
  });

  it("shows each tool definition as a block of its own, named and keyed by its name, one that does not fit raw beside the rest", () => {
    const blocks = group(
      one(request("a", { model: "m", messages: [], tools: [{ name: "Read", input_schema: {} }, { name: "Read", input_schema: { type: "object" } }, { name: "a/b", input_schema: {} }, "Bash", { name: "Grep", description: 7 }, { name: "a%2Fb" }, { name: "x\ud800" }] })),
      "tools",
    );
    // Two of one name, which the API refuses but a recording may hold, are two items; a key never nests at a `/`, is
    // another name's key never, and is made of any string, a lone surrogate's too.
    expect(blocks.map(({ key, name }) => [key, name])).toEqual([
      ["tools.Read.0", "Read"],
      ["tools.Read.1", "Read"],
      ["tools.a%2Fb.0", "a/b"],
      ["tools.tool.0", "tool"],
      ["tools.Grep.0", "Grep"],
      ["tools.a%252Fb.0", "a%2Fb"],
      ["tools.x\ud800.0", "x\ud800"],
    ]);
    expect(blocks[3]!.parts).toEqual([doesNotFit("tool definition: is not an object"), { id: "received", kind: "json", value: "Bash" }]);
    expect(blocks[4]!.parts[0]).toEqual(doesNotFit("tool definition: description: is not a string"));
  });

  it("shows a reply's usage as its JSON when it holds no fields, a string quoted, and the reply's content beside it", () => {
    for (const usage of [null, {}, undefined, "[]"]) {
      const message = { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage };
      const formatted = one([...request("a", { model: "m", messages: [] }), ...response("a", 200, [["Content-Type", "application/json"], ["Content-Encoding", "gzip"]], gzipSync(JSON.stringify(message)))]);
      expect(group(formatted, "reply").map(({ parts }) => parts)).toEqual([[{ id: "text", kind: "text", form: "markdown", text: "hi" }]]);
      expect(group(formatted, "response").find(({ name }) => name === "usage")!.parts).toEqual([{ id: "usage", kind: "text", form: "verbatim", text: String(JSON.stringify(usage)) }]);
    }
  });

  it("returns beside the blocks the facts the exchange line prints: the model from the request, the usage and stop reason from the message, the timing from the events", () => {
    const ended = "2026-11-13T08:00:02.100Z";
    const message = { ...messageStart.message, stop_reason: "end_turn", usage: { input_tokens: 4, cache_read_input_tokens: 44000, cache_creation_input_tokens: 2096, output_tokens: 390 } };
    const formatted = format([
      ...request("a", { model: "claude-fable-5-2", messages: [] }),
      ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify(message))),
      { ...at("a"), timestamp: ended, type: "end", outcome: "ok" },
      ...request("b", { model: "m", messages: [] }),
      ...request("c", { model: "m", messages: [] }),
      ...streamed("c", [messageStart, messageDelta], false),
    ]);
    const [a, b, c] = formatted.map(({ facts }) => facts);
    expect(a).toEqual({ began: timestamp, duration: 2100, status: 200, model: "claude-fable-5-2", session: undefined, uncached: 4, cacheRead: 44000, cacheWritten: 2096, output: 390, stopReason: "end_turn" });
    // The model stays among the parameters the request sent.
    expect(group(formatted[0]!, "request")[1]!.parts).toEqual([{ id: "parameters", kind: "fields", fields: [["model", '"claude-fable-5-2"']] }]);
    // One in flight: what is not known yet is undefined.
    expect(b).toEqual({ began: timestamp, duration: undefined, status: undefined, model: "m", session: undefined, uncached: undefined, cacheRead: undefined, cacheWritten: undefined, output: undefined, stopReason: undefined });
    // A stream's message as far as it has arrived: a count the API did not give is undefined.
    expect(c).toMatchObject({ status: 200, uncached: 2, cacheRead: undefined, cacheWritten: undefined, output: 90, stopReason: "tool_use" });
  });

  it("reads the agent's session from the request's metadata, as Claude Code sends it, and none from metadata of another shape", () => {
    const session = (metadata: unknown) => one(request("a", { model: "m", messages: [], metadata })).facts.session;
    expect(session({ user_id: '{"device_id":"d1","account_uuid":"u1","session_id":"049eb6bc-c30d-493a-b3e7-411df8c2a02e"}' })).toBe("049eb6bc-c30d-493a-b3e7-411df8c2a02e");
    expect([session(undefined), session({ user_id: "user_abc" }), session({ user_id: '{"session_id":7}' }), session({ user_id: { session_id: "s1" } }), session("s1")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("totals the input: the uncached, the cache read and the cache written together, each beside it as the API reported it", () => {
    const facts = (usage: object) => {
      const message = { ...messageStart.message, stop_reason: "end_turn", usage };
      const { facts } = one([...request("a", { model: "m", messages: [] }), ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify(message)))]);
      return [inputOf(facts), facts.cacheRead, facts.cacheWritten];
    };
    // A cached turn, which read most of its input and wrote some; one that used no cache; one from before the cache fields.
    expect(facts({ input_tokens: 6, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000, output_tokens: 9 })).toEqual([45006, 40000, 5000]);
    expect(facts({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 })).toEqual([120, 0, 0]);
    expect(facts({ input_tokens: 120, output_tokens: 9 })).toEqual([120, undefined, undefined]);
    // A count reported as null is not reported; without the uncached count there is no total, whatever the cache holds.
    expect(facts({ input_tokens: 7, cache_read_input_tokens: null, cache_creation_input_tokens: 3 })).toEqual([10, undefined, 3]);
    expect(facts({ cache_read_input_tokens: 40000, output_tokens: 9 })).toEqual([undefined, 40000, undefined]);
    // A stream's counts come from its message_start, and stay the same once the message_delta has added its own.
    const start = { ...messageStart, message: { ...messageStart.message, usage: { input_tokens: 3, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 1 } } };
    const streamedFacts = one([...request("a", { model: "m", messages: [] }), ...streamed("a", [start, messageDelta], false)]).facts;
    expect([inputOf(streamedFacts), streamedFacts.cacheRead, streamedFacts.cacheWritten, streamedFacts.output]).toEqual([1003, 800, 200, 90]);
  });

  it("shows a block of a type it does not know as raw JSON under its type name, in a request and in a stream", () => {
    const hologram = { type: "hologram", beam: { color: "teal" } };
    const formatted = one([
      ...request("a", { model: "m", messages: [{ role: "user", content: [hologram] }] }),
      ...streamed("a", [
        messageStart,
        { type: "content_block_start", index: 0, content_block: hologram },
        { type: "content_block_delta", index: 0, delta: { type: "beam_delta", intensity: 3 } },
        { type: "content_block_stop", index: 0 },
        { type: "sparkle", glints: 2 },
        messageDelta,
      ]),
    ]);
    expect(group(formatted, "message.0")).toEqual([{ key: "content.0", place: firstMessage, category: "user", name: "hologram", parts: [{ id: "block", kind: "json", value: hologram }] }]);
    expect(group(formatted, "reply")).toEqual([{ key: "content.0", place: { in: "reply" }, category: "assistant", name: "hologram", parts: [{ id: "block", kind: "json", value: hologram }] }]);
    // The events it cannot apply are shown too, with the exchange's own, each raw under its event name with why.
    const blocks = group(formatted, "response");
    expect(lines(blocks)).toEqual(expect.arrayContaining(["http content_block_delta event", "http sparkle event"]));
    expect(blocks.find(({ name }) => name === "sparkle event")!.parts[0]).toEqual({ kind: "text", form: "verbatim", id: "misfit", label: "not applied", text: "event: type: is not one of message_start, content_block_start, content_block_delta, content_block_stop, message_delta, error, ping, message_stop" });
  });

  it("shows a block of a known type whose fields do not fit as raw JSON, with what does not fit", () => {
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [{ type: "text", text: 5 }] }] }));
    expect(group(formatted, "message.0")).toEqual([
      {
        key: "content.0",
        place: firstMessage,
        category: "user",
        name: "text",
        parts: [
          { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "text: text: is not a string" },
          { id: "received", kind: "json", value: { type: "text", text: 5 } },
        ],
      },
    ]);
  });

  it("shows errors where the reply would be: an HTTP error, an error mid-stream, a failed connection", () => {
    const overloaded = { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_1" };
    const formatted = format([
      ...request("http", { model: "m", messages: [] }),
      ...response("http", 529, [["Content-Type", "application/json"], ["Content-Encoding", "br"]], brotliCompressSync(JSON.stringify(overloaded))),
      end("http"),
      ...request("stream", { model: "m", messages: [] }),
      ...streamed("stream", [
        messageStart,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partly" } },
        { type: "error", error: { type: "api_error", message: "Internal server error" } },
      ]),
      end("stream"),
      ...request("connection", { model: "m", messages: [] }),
      { ...at("connection"), type: "end", outcome: "error", error: "connect ECONNREFUSED 160.79.104.10:443" },
    ]);
    const replies = formatted.map((exchange) => group(exchange, "reply"));
    expect(replies[0]).toEqual([
      { key: "error", category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: overloaded.error }, { kind: "rest", id: "unread", label: "fields", fields: [["request_id", '"req_1"']] }] },
    ]);
    // What the stream had said stands, the error after it; what the API reported stays with the exchange's own.
    expect(replies[1]!.map(({ key, category, name }) => [key, category, name])).toEqual([["content.0", "assistant", "text"], ["error.0", "assistant", "error"]]);
    expect(lines(group(formatted[1]!, "response"))).toEqual(["http HTTP response", "usage stop reason: null", "usage usage", "usage message"]);
    expect(replies[2]).toEqual([{ key: "end", category: "assistant", name: "error", parts: [{ id: "error", kind: "text", form: "verbatim", text: "connect ECONNREFUSED 160.79.104.10:443" }] }]);
    expect(group(formatted[2]!, "response")).toEqual([]);
  });

  it("shows a stream as far as it has arrived, its tool's input so far as text, and once it is cut short what was not yet whole", () => {
    const sofar = sse([
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "l' } },
    ]);
    const cut = `${sofar}event: content_block_delta\ndata: {"type":"content_bl`;
    const headers: Header[] = [["Content-Type", "text/event-stream"]];
    const arriving = [...request("a", { model: "m", messages: [] }), ...response("a", 200, headers, Buffer.from(cut), false)];
    const blocks = received(one(arriving));
    expect(blocks.find(({ name }) => name === "tool_use: Bash")!.parts).toContainEqual({ kind: "text", form: "verbatim", id: "partial_json", label: "input so far", text: '{"command": "l' });
    expect(blocks.map(({ key }) => key)).not.toContain("tail");
    const cutShort = group(one([...arriving, end("a")]), "response");
    expect(cutShort.find(({ key }) => key === "tail")).toEqual({ key: "tail", category: "http", name: "stream tail", parts: [{ id: "text", kind: "text", form: "verbatim", text: 'event: content_block_delta\ndata: {"type":"content_bl' }] });
  });

  it("shows why a body is not decoded yet, and what is left of a request body not complete", () => {
    const br = response("a", 200, [["Content-Type", "application/json"], ["Content-Encoding", "br"]], brotliCompressSync("{}"), false);
    const [head, ...body] = request("a", { model: "m", messages: [] });
    const formatted = one([head!, body[0]!, ...br]);
    expect(group(formatted, "request").map(({ name }) => name)).toEqual(["HTTP request", "request body so far"]);
    expect(group(formatted, "response")[1]).toEqual({
      key: "undecoded",
      category: "http",
      name: "body not decoded",
      parts: [{ id: "error", kind: "text", form: "verbatim", text: expect.stringMatching(/^\d+ bytes wait for the body to complete: br is decoded whole$/) }],
    });
  });

  it("shows the Messages API's exchanges only, and one whose request was not recorded", () => {
    const formatted = format([
      ...request("hello", {}, { method: "HEAD", url: "/api/hello" }),
      ...request("count", { model: "m", messages: [] }, { url: "/v1/messages/count_tokens" }),
      ...request("messages", { model: "m", messages: [] }),
      ...response("unrecorded", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify({ ...messageStart.message, stop_reason: "end_turn" }))),
    ]);
    expect(formatted.map(({ exchange }) => exchange.trace_id)).toEqual(["messages", "unrecorded"]);
    expect(lines(group(formatted[1]!, "request"))).toEqual(["http HTTP request"]);
  });

  it("formats an exchange on its own, so one shown before its request head that turns out to be no Messages request leaves another as it was", () => {
    const formatter = createFormatter();
    const headless = response("other", 200, [], Buffer.from("{}"));
    const messages = request("messages", { model: "m", messages: [] });
    const first = formatter(exchanges([...headless, ...messages]));
    expect(first.map(({ exchange }) => exchange.trace_id)).toEqual(["other", "messages"]);
    const later = formatter(exchanges([...headless, ...messages, ...request("other", {}, { method: "GET", url: "/v1/models" })]));
    expect(later).toHaveLength(1);
    expect(later[0]).toBe(first[1]);
  });

  it("interns a block a later request resends as it was, and makes a block anew where its place holds another", () => {
    const tools = [{ name: "Read", description: "Reads a file." }];
    const sent = (trace: string, first: string, more: unknown[]) => request(trace, { model: "m", system: "Be brief.", tools, messages: [{ role: "user", content: first }, ...more] });
    const [a, b, c] = format([
      ...sent("a", "Hi.", []),
      ...sent("b", "Hi.", [{ role: "assistant", content: "Hello." }, { role: "user", content: "More." }]),
      ...sent("c", "Bye.", []),
    ]);
    const groupOf = ({ groups }: FormattedExchange, key: string) => groups.find((one) => one.key === key)!;
    for (const key of ["tools", "system", "message.0"]) expect(groupOf(b!, key)).toBe(groupOf(a!, key));
    for (const key of ["tools", "system"]) expect(groupOf(c!, key)).toBe(groupOf(a!, key));
    expect(groupOf(c!, "message.0")).not.toBe(groupOf(a!, "message.0"));
    expect(group(c!, "message.0").map(({ parts }) => parts)).toEqual([[{ id: "text", kind: "text", form: "markdown", text: "Bye." }]]);
  });

  it("keeps an exchange that got no new event, and a streaming exchange's request, as the objects formatted before", () => {
    const formatter = createFormatter();
    const done = [...request("done", { model: "m", messages: [] }), ...streamed("done", [messageStart]), end("done")];
    const streaming = [...request("streaming", { model: "m", messages: [{ role: "user", content: "Hi." }] }), ...streamed("streaming", [messageStart], false)];
    const first = formatter(exchanges([...done, ...streaming]));
    const later = formatter(exchanges([...done, ...streaming, end("streaming")]));
    expect(later[0]).toBe(first[0]);
    expect(later[1]).not.toBe(first[1]);
    // Its own blocks and each block it sends.
    expect(group(later[1]!, "request")).toBe(group(first[1]!, "request"));
    expect(group(later[1]!, "message.0")[0]).toBe(group(first[1]!, "message.0")[0]);
  });

  it("keys each block by what it is, so a block keeps its key as a stream adds blocks around it", () => {
    const events = [
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
      { type: "sparkle" },
      messageDelta,
    ];
    const keys = (count: number) => {
      const blocks = received(one([...request("a", { model: "m", messages: [] }), ...streamed("a", events.slice(0, count), false)]));
      return Object.fromEntries(blocks.map(({ key, name }) => [name, key]));
    };
    expect(keys(3)).toEqual({ "HTTP response": "http", text: "content.0", "stop reason: null": "stop reason", usage: "usage", message: "fields" });
    expect(keys(7)).toEqual({
      "HTTP response": "http",
      text: "content.0",
      "tool_use: Bash": "content.1",
      "stop reason: tool_use": "stop reason",
      usage: "usage",
      message: "fields",
      "sparkle event": "event.0",
    });
    const formatted = one(request("a", { model: "m", system: "s", messages: [{ role: "user", content: "Hi." }] }));
    // A request whose body is whole has its tools' and its system prompt's groups, whether or not it sends any.
    expect(formatted.groups.map(({ key, blocks }) => [key, blocks.map(({ key }) => key)])).toEqual([
      ["request", ["http", "parameters"]],
      ["response", []],
      ["tools", []],
      ["system", ["system.0"]],
      ["message.0", ["content.0"]],
      ["reply", []],
    ]);
  });

  it("shows what the harness injected into a user message as blocks of their own, each named for what it is, and the prompt alone", () => {
    const reminder = (inner: string) => `<system-reminder>\n${inner}\n</system-reminder>`;
    const notes = "Contents of /work/app/CLAUDE.md (project instructions, checked into the codebase):\n\n## Build\nRun make.";
    const context = reminder(`Codebase and user instructions are shown below.\n\n${notes}`);
    const messages = [
      { role: "user", content: [{ type: "text", text: context }, { type: "text", text: "Say hello.", cache_control: { type: "ephemeral" } }, { type: "image", source: png }] },
      { role: "system", content: [{ type: "text", text: "SessionStart hook additional context: Be explanatory." }] },
      { role: "user", content: "Again." },
    ];
    const formatted = one(request("a", { model: "m", messages }));
    const [user, system, again] = formatted.groups.filter(({ key }) => key.startsWith("message"));
    const shown = ({ blocks }: { blocks: Array<Block & { key: string }> }) => blocks.map(({ key, name, category, injected }) => [key, name, category, injected]);
    expect(shown(user!)).toEqual([
      ["content.0.0", "system reminder", "user", true],
      ["content.0.1", "CLAUDE.md /work/app/CLAUDE.md", "user", true],
      ["content.1", "text", "user", undefined],
      ["content.2", "image", "user", undefined],
    ]);
    // The pieces are the text, nothing lost and nothing twice, and the prompt's other fields stay with it.
    expect(user!.blocks.slice(0, 2).map(({ parts }) => parts)).toEqual([
      [{ id: "text", kind: "text", form: "markdown", text: "<system-reminder>\nCodebase and user instructions are shown below.\n\n" }],
      [{ id: "text", kind: "text", form: "markdown", text: `${notes}\n</system-reminder>` }],
    ]);
    expect(user!.blocks[2]!.parts).toEqual([{ id: "text", kind: "text", form: "markdown", text: "Say hello." }]);
    // Whatever the role, and the category stays the role's. A hook's output is what a program printed, so it reads verbatim.
    expect(shown(system!)).toEqual([["content.0", "SessionStart hook", "system", true]]);
    expect(system!.blocks[0]!.parts).toEqual([{ id: "text", kind: "text", form: "verbatim", text: "SessionStart hook additional context: Be explanatory." }]);
    expect(shown(again!)).toEqual([["content.0", "text", "user", undefined]]);
  });

  it("splits no text but a user's or a system-role message's: a tool result's, the system prompt's, an assistant's and the reply's stay as sent", () => {
    const reminder = "<system-reminder>\nUse the tool.\n</system-reminder>";
    const formatted = one([
      ...request("a", {
        model: "m",
        system: [{ type: "text", text: reminder }],
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: reminder }] }] },
          { role: "assistant", content: [{ type: "text", text: `It said:\n${reminder}` }] },
        ],
      }),
      ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify({ ...messageStart.message, content: [{ type: "text", text: reminder }] }))),
    ]);
    expect(group(formatted, "system")).toMatchObject([{ key: "system.0", name: "text", parts: [{ id: "text", kind: "text", form: "markdown", text: reminder }] }]);
    expect(group(formatted, "message.0")[0]!.parts).toContainEqual({ id: "0/text", kind: "text", form: "verbatim", text: reminder });
    expect(group(formatted, "message.1")).toMatchObject([{ key: "content.0", name: "text", parts: [{ id: "text", kind: "text", form: "markdown", text: `It said:\n${reminder}` }] }]);
    expect(group(formatted, "reply")).toMatchObject([{ key: "content.0", name: "text", parts: [{ id: "text", kind: "text", form: "markdown", text: reminder }] }]);
  });

  it("formats a reply as the next request resends it, at the next message's place", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "c2ln" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
    ];
    const [replied, resent] = format([
      ...request("a", { model: "m", messages: [{ role: "user", content: "Read /a." }] }),
      ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify({ ...messageStart.message, content }))),
      ...request("b", { model: "m", messages: [{ role: "user", content: "Read /a." }, { role: "assistant", content }] }),
    ]);
    const reply = group(replied!, "reply");
    expect(replied!.messages).toBe(1);
    expect(reply.map(({ place, ...block }) => [place, block])).toEqual(group(resent!, "message.1").map((block) => [{ in: "reply" }, { ...block, place: undefined }]));
    expect(group(resent!, "message.1").map(({ place }) => place)).toEqual(content.map(() => ({ in: "message", index: 1 })));
  });

  it("shows a block whose type names a property every object has as a block of a type it does not know", () => {
    const constructor = { type: "constructor", value: 1 };
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [constructor] }] }));
    expect(group(formatted, "message.0")).toEqual([{ key: "content.0", place: firstMessage, category: "user", name: "constructor", parts: [{ id: "block", kind: "json", value: constructor }] }]);
  });

  it("shows a tool result with no content, as a failed tool may return, named for its tool's failure and marked failed", () => {
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] }] }));
    expect(group(formatted, "message.0")).toEqual([
      {
        key: "content.0",
        place: firstMessage,
        category: "tools",
        name: "tool_result: error",
        parts: [{ id: "tool_use_id", kind: "fields", fields: [["tool_use_id", "toolu_1"], ["is_error", "true"]] }],
        failed: true,
        result: { answers: "toolu_1", names: undefined },
      },
    ]);
  });

  it("states what an Agent or a Skill tool's call launches, in a message and in the reply, the agent type once its input says it", () => {
    const call = (name: string, input: unknown) => ({ type: "tool_use", id: "toolu_1", name, input });
    const sent = (content: unknown[]) => group(one(request("a", { model: "m", messages: [{ role: "assistant", content }] })), "message.0").map(({ call }) => call?.launches);
    expect(sent([call("Agent", { description: "Look", prompt: "Find the bug.\n", subagent_type: "Explore" }), call("Agent", { prompt: "Go." }), call("Skill", { skill: "review" })])).toEqual([
      { tool: "Agent", type: "Explore" },
      { tool: "Agent", type: undefined },
      { tool: "Skill", skill: "review" },
    ]);
    // Another tool's prompt launches nothing; an Agent's call launches an agent whatever its input holds.
    const agent = { tool: "Agent", type: undefined };
    expect(sent([call("WebFetch", { url: "https://example.com", prompt: "Find the bug." }), call("Agent", { prompt: 5 }), call("Agent", "{}")])).toEqual([undefined, agent, agent]);
    const start = { type: "content_block_start", index: 0, content_block: call("Agent", {}) };
    const delta = (partial_json: string) => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } });
    const events = [messageStart, start, delta('{"subagent_type":'), delta('"Explore"}'), { type: "content_block_stop", index: 0 }];
    const reply = (count: number) => group(one([...request("a", { model: "m", messages: [] }), ...streamed("a", events.slice(0, count), false)]), "reply").map(({ call }) => call?.launches);
    expect(reply(4)).toEqual([agent]);
    expect(reply(5)).toEqual([{ tool: "Agent", type: "Explore" }]);
  });

  it("states each call by its id, and that every call's reply waits for its result but SubagentHandback's; a call with no id states none", () => {
    const call = (name: string, id: unknown = "toolu_1") => ({ type: "tool_use", id, name, input: { message: "Done." } });
    const content = [call("SubagentHandback"), call("SendMessage", "toolu_2"), call("Bash", 7)];
    expect(group(one(request("a", { model: "m", messages: [{ role: "assistant", content }] })), "message.0").map(({ call }) => call)).toEqual([
      { id: "toolu_1", launches: undefined, waits: false },
      { id: "toolu_2", launches: undefined, waits: true },
      undefined,
    ]);
  });

  it("states the call a result answers, and the agent its content names in the background frame or the foreground trailer", () => {
    const launched = "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ae5c3bca3aecbe477 (internal ID - do not mention to user.)\nThe agent is working in the background.";
    const usage = "<usage>subagent_tokens: 10\ntool_uses: 2\nduration_ms: 300</usage>";
    const results = [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: launched }] },
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "The bug is here." }, { type: "text", text: `agentId: a1 (use SendMessage with to: 'a1' to continue this agent)\n${usage}` }] },
      // A report that is a single text has the trailer appended, and worktree lines may follow the id.
      { type: "tool_result", tool_use_id: "toolu_3", content: [{ type: "text", text: `The bug is here.\nagentId: a2\nworktreePath: /w\nworktreeBranch: b\n${usage}` }] },
      // A result that quotes a frame anywhere else names nothing, nor does a foreground Explore's, which has no trailer.
      { type: "tool_result", tool_use_id: "toolu_4", content: `cat log\nagentId: a3 (internal ID` },
      { type: "tool_result", tool_use_id: "toolu_5", content: "The bug is here." },
      // The trailer's id is the last on its own line: a report that quotes another agent's names that one nowhere.
      { type: "tool_result", tool_use_id: "toolu_6", content: [{ type: "text", text: `Report:\nagentId: zzz\nmore\nagentId: a4 (use SendMessage with to: 'a4' to continue this agent)\n${usage}` }] },
    ];
    expect(group(one(request("a", { model: "m", messages: [{ role: "user", content: results }] })), "message.0").map(({ result }) => result)).toEqual([
      { answers: "toolu_1", names: "ae5c3bca3aecbe477" },
      { answers: "toolu_2", names: "a1" },
      { answers: "toolu_3", names: "a2" },
      { answers: "toolu_4", names: undefined },
      { answers: "toolu_5", names: undefined },
      { answers: "toolu_6", names: "a4" },
    ]);
  });

  it("states a notification that an agent stopped from a text that is wholly one reminder holding it, and never from a person's text that quotes one", () => {
    const notification = (inner: string) => `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n${inner}\n</task-notification>\n</system-reminder>`;
    const killed = notification("<task-id>aeb0927abd04e4d83</task-id>\n<status>killed</status>\n<summary>Agent was stopped</summary>");
    const done = notification("<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>");
    const statusless = notification("<task-id>a2</task-id>\n<summary>Agent was stopped</summary>");
    const two = notification("<task-id>a3</task-id>\n<status>completed</status>\n</task-notification>\n<task-notification>\n<task-id>a4</task-id>\n<status>failed</status>");
    const texts = [killed, done, `Look at this: ${done}`, `${done}\n<system-reminder>\nToday is Friday.\n</system-reminder>`, statusless, two];
    const blocks = group(one(request("a", { model: "m", messages: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }] })), "message.0");
    const notices = blocks.filter(({ notice }) => notice !== undefined);
    expect(notices.map(({ name, injected, notice }) => ({ name, injected, notice }))).toEqual([
      { name: "task notification", injected: true, notice: { kind: "stop", agent: "aeb0927abd04e4d83", status: "killed", call: undefined } },
      { name: "task notification", injected: true, notice: { kind: "stop", agent: "a1", status: "completed", call: "toolu_1" } },
      // One that lacks its agent or its status, or holds two, is shown as a notification that was not read, and tells
      // no stop.
      { name: "task notification not read: no <status>", injected: true, notice: { kind: "unread", why: "no <status>" } },
      { name: "task notification not read: more than one <task-notification>", injected: true, notice: { kind: "unread", why: "more than one <task-notification>" } },
    ]);
    // Its collapsed line reads its `<task-notification>` element, without the reminder around it.
    const shown = (notices[1]!.preview ?? []).flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("");
    expect([shown.startsWith("<task-notification>"), shown.trimEnd().endsWith("</task-notification>")]).toEqual([true, true]);
  });

  it("states the summary an assistant's text ends with, and none of a text that only holds one", () => {
    const said = (role: string, text: string) => group(one(request("a", { model: "m", messages: [{ role, content: [{ type: "text", text }] }] })), "message.0").map(({ summary }) => summary);
    expect(said("assistant", "<analysis>\nThought.\n</analysis>\n\n<summary>\n1. Did it.\n</summary>\n")).toEqual(["1. Did it."]);
    // The summary runs to the tag that ends the text, whatever it quotes.
    expect(said("assistant", "<summary>The reply held <summary>x</summary> once.</summary>")).toEqual(["The reply held <summary>x</summary> once."]);
    expect(said("assistant", "<details><summary>More</summary>\nText.\n</details>")).toEqual([undefined]);
    expect(said("assistant", "<summary>Done.</summary>\nAnd then more.")).toEqual([undefined]);
    expect(said("assistant", "<summary>  </summary>")).toEqual([undefined]);
    expect(said("user", "<summary>Done.</summary>")).toEqual([undefined]);
  });

  it("marks no tool result failed whose is_error is not true", () => {
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: "ok" }] }] }));
    expect(group(formatted, "message.0")[0]).not.toHaveProperty("failed");
  });

  it("marks failed a failed tool's result its entry cannot read, and a server tool's result of its error type", () => {
    const formatted = one(
      request("a", {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: 1, is_error: true },
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: [] },
            ],
          },
        ],
      }),
    );
    expect(group(formatted, "message.0").map(({ name, failed }) => [name, failed])).toEqual([
      ["tool_result: error", true],
      ["web_search_tool_result: error", true],
      ["web_search_tool_result", undefined],
    ]);
  });

  it("decodes a body whose trailers were not recorded once its exchange has ended", () => {
    const message = { ...messageStart.message, stop_reason: "end_turn" };
    const formatted = one([
      ...request("a", { model: "m", messages: [] }),
      ...response("a", 200, [["Content-Type", "application/json"], ["Content-Encoding", "br"]], brotliCompressSync(JSON.stringify(message)), false),
      end("a"),
    ]);
    expect(lines(group(formatted, "response"))).toEqual(["http HTTP response", "usage stop reason: end_turn", "usage usage", "usage message"]);
  });

  it("shows no text for a body it cannot decode: a coding it does not know, or a chunk that is not base64", () => {
    const formatted = format([
      ...request("coding", { model: "m", messages: [] }),
      ...response("coding", 200, [["Content-Type", "text/event-stream"], ["Content-Encoding", "compress"]], gzipSync(sse([messageStart]))),
      ...request("base64", { model: "m", messages: [] }),
      { ...at("base64"), type: "response", status: 200, reason: "", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
      { ...at("base64"), type: "response_body", base64: "not base64!" },
      { ...at("base64"), type: "response_trailers", headers: [] },
    ]);
    const [coding, base64] = formatted.map((exchange) => group(exchange, "response").slice(1));
    expect(coding).toEqual([{ key: "undecoded", category: "http", name: "body not decoded", parts: [{ id: "error", kind: "text", form: "verbatim", text: "content-encoding compress is not one this view decodes" }] }]);
    // A body that did not decode is not parsed, so its one failure is shown once.
    expect(lines(base64!)).toEqual(["http body not decoded"]);
  });

  it("does not show a request whose target is no URL", () => {
    expect(format(request("a", { model: "m", messages: [] }, { url: "http://[bad" }))).toEqual([]);
  });

  it("shows a streamed message as the same blocks as the message a non-streaming response returns", () => {
    const content = [{ type: "text", text: "Hi." }];
    const message = { ...messageStart.message, content, stop_reason: "end_turn", stop_sequence: null };
    const streamedMessage = one([
      ...request("a", { model: "m", messages: [] }),
      ...streamed("a", [
        { ...messageStart, message: { ...messageStart.message, usage: message.usage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: {} },
        { type: "message_stop" },
      ]),
    ]);
    const returned = one([...request("a", { model: "m", messages: [] }), ...response("a", 200, [["Content-Type", "application/json"]], Buffer.from(JSON.stringify(message)))]);
    expect(received(streamedMessage).slice(1)).toEqual(received(returned).slice(1));
    expect(group(streamedMessage, "reply")).toHaveLength(1);
  });

  it("builds a stream's blocks and message from what its events carry, and shows an event that breaks the stream", () => {
    const blocks = received(
      one([
        ...request("a", { model: "m", messages: [] }),
        ...streamed("a", [
          messageStart,
          // A thinking block may start without its signature, which its delta then begins.
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": ' } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          messageDelta,
          { type: "message_stop", metrics: { latency_ms: 812 } },
        ]),
      ]),
    );
    expect(blocks.find(({ name }) => name === "thinking")!.parts).toEqual([{ id: "thinking", kind: "text", form: "markdown", text: "" }, { id: "signature", kind: "fields", fields: [["signature", "4 characters"]] }]);
    const notApplied = blocks.filter(({ name }) => name.endsWith(" event")).map(({ name, parts }) => `${name}: ${(parts[0] as { text: string }).text}`);
    expect(notApplied).toEqual([
      expect.stringMatching(/^content_block_stop event: the block's streamed input: is not JSON/),
      "content_block_start event: content block 1 has already started",
    ]);
    expect(blocks.find(({ name }) => name === "message")!.parts[0]).toEqual({ kind: "rest", id: "unread", label: "fields", fields: expect.arrayContaining([["metrics", [["latency_ms", "812"]]]]) });
  });

  it("says a body is not UTF-8, as a compressed body is when its head and so its coding were not recorded", () => {
    const [, ...body] = response("a", 200, [], gzipSync("{}"));
    const blocks = group(one([...body, end("a")]), "response");
    expect(lines(blocks)).toEqual(["http HTTP response", "http body not decoded", "http response body so far"]);
    expect(blocks[1]!.parts).toEqual([{ id: "error", kind: "text", form: "verbatim", text: "the body is not UTF-8: what is not is shown as U+FFFD" }]);
  });

  it("shows a thinking block while it streams, before its signature arrives", () => {
    const blocks = received(
      one([
        ...request("a", { model: "m", messages: [] }),
        ...streamed(
          "a",
          [
            { type: "ping" },
            messageStart,
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } },
          ],
          false,
        ),
      ]),
    );
    // A ping before the message begins builds nothing and is nothing wrong.
    expect(lines(blocks)).toEqual(["http HTTP response", "usage stop reason: null", "usage usage", "usage message", "thinking thinking"]);
    expect(blocks[4]!.parts).toEqual([{ id: "thinking", kind: "text", form: "markdown", text: "Let me think" }, { id: "signature", kind: "fields", fields: [["signature", "none"]] }]);
  });

  it("shows a second message_start as an event not applied, keeping the message it began", () => {
    const blocks = received(
      one([...request("a", { model: "m", messages: [] }), ...streamed("a", [messageStart, { ...messageStart, message: { ...messageStart.message, id: "msg_2" } }])]),
    );
    expect(blocks.find(({ name }) => name === "message")!.parts[0]).toEqual({ kind: "rest", id: "unread", label: "fields", fields: expect.arrayContaining([["id", '"msg_1"']]) });
    expect(blocks.find(({ name }) => name === "message_start event")!.parts[0]).toEqual({ kind: "text", form: "verbatim", id: "misfit", label: "not applied", text: "the message has already started" });
  });

  it("shows a delta or a stop for a block that has stopped as an event not applied, keeping the input it stopped with", () => {
    const blocks = received(
      one([
        ...request("a", { model: "m", messages: [] }),
        ...streamed("a", [
          messageStart,
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "ls"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ', "more": 1' } },
          { type: "content_block_stop", index: 0 },
        ]),
      ]),
    );
    expect(blocks.find(({ category }) => category === "tools")!.parts).toContainEqual({ kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" });
    const notApplied = blocks.filter(({ name }) => name.endsWith(" event")).map(({ name, parts }) => `${name}: ${(parts[0] as { text: string }).text}`);
    expect(notApplied).toEqual(["content_block_delta event: content block 0 has stopped", "content_block_stop event: content block 0 has stopped"]);
  });

  it("decodes a deflate body cut short as far as its bytes allow", () => {
    const text = sse([messageStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ...Array.from({ length: 400 }, () => ({ type: "ping" }))]);
    const deflated = deflateSync(text);
    const formatted = one([
      ...request("a", { model: "m", messages: [] }),
      ...response("a", 200, [["Content-Type", "text/event-stream"], ["Content-Encoding", "deflate"]], deflated.subarray(0, deflated.length - 6), false),
      end("a"),
    ]);
    expect(lines(group(formatted, "response")).slice(0, 3)).toEqual(["http HTTP response", "http body not decoded", "usage stop reason: null"]);
    expect(lines(group(formatted, "reply"))).toEqual(["assistant text"]);
  });

  it("shows each field of a source of a type it does not know once", () => {
    const image = { type: "image", source: { type: "s3", bucket: "b", key: "k" } };
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [image] }] }));
    expect(group(formatted, "message.0")[0]!.parts).toEqual([
      { kind: "fields", id: "source", label: "source", fields: [["type", "s3"]] },
      { kind: "rest", id: "source/unread", label: "source fields", fields: [["bucket", '"b"'], ["key", '"k"']] },
    ]);
  });
});
