import type { Header, RecordedEvent } from "@cc-dump/proxy/format";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import type { Block } from "./blocks.ts";
import { createFormatter, type FormattedExchange } from "./format.ts";

// Recorded events as the proxy writes them, with bodies in the shapes Claude Code and the Messages API put on the wire.
const timestamp = "2026-11-13T08:00:00.000Z";
const at = (trace_id: string) => ({ timestamp, trace_id });
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
const group = ({ groups }: FormattedExchange, title: string, nth = 0) => groups.filter((group) => group.title === title)[nth]!.blocks;

const png = { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" };
const messageStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-2", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } } };
const messageDelta = { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 90 }, context_management: { applied_edits: [] } };

describe("format", () => {
  it("shows every content block of a session with its category, request then response", () => {
    const body = {
      model: "claude-fable-5-2",
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "omitted" },
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

    expect(lines(group(formatted, "request"))).toEqual(["metadata HTTP request", "metadata parameters", "tools tool definitions: 2", "system text"]);
    expect(lines(group(formatted, "user"))).toEqual(["user text", "user image", "user document"]);
    expect(lines(group(formatted, "assistant"))).toEqual([
      "thinking thinking",
      "thinking redacted_thinking",
      "assistant text",
      "tools tool_use: Read",
      "tools server_tool_use: web_search",
      "tools web_search_tool_result",
    ]);
    expect(lines(group(formatted, "user", 1))).toEqual(["tools tool_result"]);
    expect(lines(group(formatted, "system"))).toEqual(["system text"]);
    expect(lines(group(formatted, "response"))).toEqual([
      "metadata HTTP response",
      "thinking thinking",
      "assistant text",
      "tools tool_use: Bash",
      "metadata stop reason: tool_use",
      "metadata usage",
      "metadata message",
    ]);

    // The content each shows: the image, the text document, the tool result's text and image, the streamed message.
    expect(group(formatted, "user")[1]!.parts).toEqual([{ kind: "media", source: png }]);
    expect(group(formatted, "user")[2]!.parts).toEqual([
      { kind: "text", text: "Quarterly notes" },
      { kind: "json", label: "source fields", value: { media_type: "text/plain" } },
      { kind: "json", label: "fields", value: { title: "notes" } },
    ]);
    expect(group(formatted, "user", 1)[0]!.parts).toEqual([
      { kind: "fields", fields: [["tool_use_id", "toolu_1"]] },
      { kind: "text", text: "Read 1 image" },
      { kind: "media", source: png },
    ]);
    const [, thinking, text, toolUse, , usage, message] = group(formatted, "response");
    // A field of an event that nothing reads lands on the block the event builds: the thinking delta's estimate.
    expect(thinking!.parts).toEqual([
      { kind: "text", text: "" },
      { kind: "fields", fields: [["signature", "4 characters"]] },
      { kind: "json", label: "fields", value: { estimated_tokens: 50 } },
    ]);
    expect(text!.parts).toEqual([{ kind: "text", text: "Red and blue." }]);
    expect(toolUse!.parts).toContainEqual({ kind: "json", label: "input", value: { command: "ls" } });
    expect(usage!.parts).toEqual([{ kind: "json", value: { input_tokens: 2, output_tokens: 90 } }]);
    expect(message!.parts).toEqual([{ kind: "json", label: "fields", value: expect.objectContaining({ id: "msg_1", context_management: { applied_edits: [] } }) }]);
    // A parameter or a field this view does not name is shown with the rest, not dropped.
    expect(group(formatted, "request")[1]!.parts).toEqual([{ kind: "json", value: { model: "claude-fable-5-2", max_tokens: 32000, thinking: body.thinking } }]);
    expect(group(formatted, "request")[3]!.parts).toContainEqual({ kind: "json", label: "fields", value: { cache_control: { type: "ephemeral" } } });
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
    expect(group(formatted, "user")).toEqual([{ key: "content.0", category: "user", name: "hologram", parts: [{ kind: "json", value: hologram }] }]);
    const blocks = group(formatted, "response");
    expect(blocks).toContainEqual({ key: "content.0", category: "assistant", name: "hologram", parts: [{ kind: "json", value: hologram }] });
    // The events it cannot apply are shown too, each raw under its event name with why.
    expect(lines(blocks)).toEqual(expect.arrayContaining(["metadata content_block_delta event", "metadata sparkle event"]));
    expect(blocks.find(({ name }) => name === "sparkle event")!.parts[0]).toEqual({ kind: "text", label: "not applied", text: "sparkle is not an event this view applies" });
  });

  it("shows a block of a known type whose fields do not fit as raw JSON, with what does not fit", () => {
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [{ type: "text", text: 5 }] }] }));
    expect(group(formatted, "user")).toEqual([
      {
        key: "content.0",
        category: "user",
        name: "text",
        parts: [
          { kind: "text", label: "does not fit", text: "text's text is not a string" },
          { kind: "json", value: { type: "text", text: 5 } },
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
    const responses = formatted.map((exchange) => group(exchange, "response"));
    expect(responses[0]!.slice(1)).toEqual([
      { key: "error", category: "assistant", name: "error", parts: [{ kind: "json", value: overloaded.error }, { kind: "json", label: "fields", value: { request_id: "req_1" } }] },
    ]);
    expect(lines(responses[1]!)).toEqual(["metadata HTTP response", "assistant text", "metadata stop reason: null", "metadata usage", "metadata message", "assistant error"]);
    expect(responses[2]).toEqual([{ key: "end", category: "assistant", name: "error", parts: [{ kind: "text", text: "connect ECONNREFUSED 160.79.104.10:443" }] }]);
  });

  it("shows a stream as far as it has arrived, and the part not yet whole", () => {
    const sofar = sse([
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "l' } },
    ]);
    const cut = `${sofar}event: content_block_delta\ndata: {"type":"content_bl`;
    const headers: Header[] = [["Content-Type", "text/event-stream"]];
    const blocks = group(one([...request("a", { model: "m", messages: [] }), ...response("a", 200, headers, Buffer.from(cut), false)]), "response");
    expect(blocks.find(({ name }) => name === "tool_use: Bash")!.parts).toContainEqual({ kind: "json", label: "input", value: '{"command": "l' });
    expect(blocks.at(-1)).toEqual({ key: "tail", category: "metadata", name: "stream tail", parts: [{ kind: "text", text: 'event: content_block_delta\ndata: {"type":"content_bl' }] });
  });

  it("shows why a body is not decoded yet, and what is left of a request body not complete", () => {
    const br = response("a", 200, [["Content-Type", "application/json"], ["Content-Encoding", "br"]], brotliCompressSync("{}"), false);
    const [head, ...body] = request("a", { model: "m", messages: [] });
    const formatted = one([head!, body[0]!, ...br]);
    expect(group(formatted, "request").map(({ name }) => name)).toEqual(["HTTP request", "request body so far"]);
    expect(group(formatted, "response")[1]).toEqual({
      key: "undecoded",
      category: "metadata",
      name: "body not decoded",
      parts: [{ kind: "text", text: expect.stringMatching(/^\d+ bytes wait for the body to complete: br is decoded whole$/) }],
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
    expect(lines(group(formatted[1]!, "request"))).toEqual(["metadata HTTP request"]);
  });

  it("keeps an exchange that got no new event, and a streaming exchange's request, as the objects formatted before", () => {
    const formatter = createFormatter();
    const done = [...request("done", { model: "m", messages: [] }), ...streamed("done", [messageStart]), end("done")];
    const streaming = [...request("streaming", { model: "m", messages: [] }), ...streamed("streaming", [messageStart], false)];
    const first = formatter(exchanges([...done, ...streaming]));
    const later = formatter(exchanges([...done, ...streaming, end("streaming")]));
    expect(later[0]).toBe(first[0]);
    expect(later[1]).not.toBe(first[1]);
    expect(later[1]!.groups[0]).toBe(first[1]!.groups[0]);
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
      const blocks = group(one([...request("a", { model: "m", messages: [] }), ...streamed("a", events.slice(0, count), false)]), "response");
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
    expect(formatted.groups.map(({ key, blocks }) => [key, blocks.map(({ key }) => key)])).toEqual([
      ["request", ["http", "parameters", "system.0"]],
      ["message.0", ["content.0"]],
      ["response", []],
    ]);
  });

  it("shows a block whose type names a property every object has as a block of a type it does not know", () => {
    const constructor = { type: "constructor", value: 1 };
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [constructor] }] }));
    expect(group(formatted, "user")).toEqual([{ key: "content.0", category: "user", name: "constructor", parts: [{ kind: "json", value: constructor }] }]);
  });

  it("shows a tool result with no content, as a failed tool may return", () => {
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] }] }));
    expect(group(formatted, "user")).toEqual([
      {
        key: "content.0",
        category: "tools",
        name: "tool_result",
        parts: [
          { kind: "fields", fields: [["tool_use_id", "toolu_1"]] },
          { kind: "json", label: "fields", value: { is_error: true } },
        ],
      },
    ]);
  });

  it("decodes a body whose trailers were not recorded once its exchange has ended", () => {
    const message = { ...messageStart.message, stop_reason: "end_turn" };
    const formatted = one([
      ...request("a", { model: "m", messages: [] }),
      ...response("a", 200, [["Content-Type", "application/json"], ["Content-Encoding", "br"]], brotliCompressSync(JSON.stringify(message)), false),
      end("a"),
    ]);
    expect(lines(group(formatted, "response"))).toEqual(["metadata HTTP response", "metadata stop reason: end_turn", "metadata usage", "metadata message"]);
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
    expect(coding).toEqual([{ key: "undecoded", category: "metadata", name: "body not decoded", parts: [{ kind: "text", text: "content-encoding compress is not one this view decodes" }] }]);
    // A body that did not decode is not parsed, so its one failure is shown once.
    expect(lines(base64!)).toEqual(["metadata body not decoded"]);
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
    expect(group(streamedMessage, "response").slice(1)).toEqual(group(returned, "response").slice(1));
  });

  it("builds a stream's blocks and message from what its events carry, and shows an event that breaks the stream", () => {
    const blocks = group(
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
      "response",
    );
    expect(blocks.find(({ name }) => name === "thinking")!.parts).toEqual([{ kind: "text", text: "" }, { kind: "fields", fields: [["signature", "4 characters"]] }]);
    const notApplied = blocks.filter(({ name }) => name.endsWith(" event")).map(({ name, parts }) => `${name}: ${(parts[0] as { text: string }).text}`);
    expect(notApplied).toEqual([
      expect.stringMatching(/^content_block_stop event: the block's streamed input is not JSON/),
      "content_block_start event: content block 1 has already started",
    ]);
    expect(blocks.find(({ name }) => name === "message")!.parts[0]).toEqual({ kind: "json", label: "fields", value: expect.objectContaining({ metrics: { latency_ms: 812 } }) });
  });

  it("says a body is not UTF-8, as a compressed body is when its head and so its coding were not recorded", () => {
    const [, ...body] = response("a", 200, [], gzipSync("{}"));
    const blocks = group(one([...body, end("a")]), "response");
    expect(lines(blocks)).toEqual(["metadata HTTP response", "metadata body not decoded", "metadata response body so far"]);
    expect(blocks[1]!.parts).toEqual([{ kind: "text", text: "the body is not UTF-8: what is not is shown as U+FFFD" }]);
  });

  it("shows a thinking block while it streams, before its signature arrives", () => {
    const blocks = group(
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
      "response",
    );
    // A ping before the message begins builds nothing and is nothing wrong.
    expect(lines(blocks)).toEqual(["metadata HTTP response", "thinking thinking", "metadata stop reason: null", "metadata usage", "metadata message"]);
    expect(blocks[1]!.parts).toEqual([{ kind: "text", text: "Let me think" }, { kind: "fields", fields: [["signature", "none"]] }]);
  });

  it("shows a second message_start as an event not applied, keeping the message it began", () => {
    const blocks = group(
      one([...request("a", { model: "m", messages: [] }), ...streamed("a", [messageStart, { ...messageStart, message: { ...messageStart.message, id: "msg_2" } }])]),
      "response",
    );
    expect(blocks.find(({ name }) => name === "message")!.parts[0]).toEqual({ kind: "json", label: "fields", value: expect.objectContaining({ id: "msg_1" }) });
    expect(blocks.find(({ name }) => name === "message_start event")!.parts[0]).toEqual({ kind: "text", label: "not applied", text: "the message has already started" });
  });

  it("shows a delta or a stop for a block that has stopped as an event not applied, keeping the input it stopped with", () => {
    const blocks = group(
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
      "response",
    );
    expect(blocks.find(({ category }) => category === "tools")!.parts).toContainEqual(expect.objectContaining({ kind: "json", value: { command: "ls" } }));
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
    expect(lines(group(formatted, "response")).slice(0, 4)).toEqual(["metadata HTTP response", "metadata body not decoded", "assistant text", "metadata stop reason: null"]);
  });

  it("shows each field of a source of a type it does not know once", () => {
    const image = { type: "image", source: { type: "s3", bucket: "b", key: "k" } };
    const formatted = one(request("a", { model: "m", messages: [{ role: "user", content: [image] }] }));
    expect(group(formatted, "user")[0]!.parts).toEqual([
      { kind: "fields", label: "source", fields: [["type", "s3"]] },
      { kind: "json", label: "source fields", value: { bucket: "b", key: "k" } },
    ]);
  });
});
