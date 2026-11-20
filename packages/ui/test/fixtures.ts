import type { Header, RecordedEvent } from "@cc-dump/proxy/format";

// Recorded events as the proxy writes them, in the shapes Claude Code puts on the wire (docs/design/claude-code-wire.md),
// for the tests that build a recording: requests by who sent them, replies, and the blocks that say what agents do.

export const timestamp = "2026-11-15T14:00:00.000Z";
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

// Who sends a request: the main agent, with no agent header; a subagent, by its id and the agent that launched it; or
// the headers as given, as a request whose headers contradict each other has them.
export type From = { agent?: string; parent?: string } | { headers: Header[] };
const headersOf = (from: From): Header[] =>
  "headers" in from ? from.headers : [...(from.agent === undefined ? [] : [["x-claude-code-agent-id", from.agent] as Header]), ...(from.parent === undefined ? [] : [["x-claude-code-parent-agent-id", from.parent] as Header])];

export const request = (trace_id: string, body: unknown, from: From = {}): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: headersOf(from) },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];

// A reply, which ends its turn unless it says why else it stopped. `ended`: when its exchange ended, or false for one
// still coming.
export const reply = (trace_id: string, content: unknown[], stop_reason = "end_turn", ended: string | false = timestamp): RecordedEvent[] => [
  { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { timestamp, trace_id, type: "response_body", base64: base64({ id: `msg_${trace_id}`, type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) },
  ...(ended === false ? [] : ([{ timestamp, trace_id, type: "response_trailers", headers: [] }, { timestamp: ended, trace_id, type: "end", outcome: "ok" }] as RecordedEvent[])),
];

// A reply still coming, streamed as the API streams one: its message's start and each of its content blocks whole, and
// nothing after, so the message has not stopped and the exchange has not ended.
export const streaming = (trace_id: string, content: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[]): RecordedEvent[] => {
  const events = [
    { type: "message_start", message: { id: `msg_${trace_id}`, type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } },
      { type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      { type: "content_block_stop", index },
    ]),
  ];
  const sse = events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return [
    { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "text/event-stream"]] },
    { timestamp, trace_id, type: "response_body", base64: Buffer.from(sse).toString("base64") },
  ];
};

export const text = (text: string) => ({ type: "text" as const, text });
export const user = (...content: unknown[]) => ({ role: "user", content });
export const assistant = (...content: unknown[]) => ({ role: "assistant", content });

// A client tool's call and its result.
export const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
export const agentCall = (id: string, prompt: string, type?: string) => call(id, "Agent", { description: "Look", prompt, ...(type === undefined ? {} : { subagent_type: type }) });
export const result = (tool_use_id: string, content: unknown) => ({ type: "tool_result", tool_use_id, content });

// What an Agent call's result says as its agent starts in the background, and as one run in the foreground returns.
export const launched = (agent: string) =>
  `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agent} (internal ID - do not mention to user.)\nThe agent is working in the background.`;
export const returned = (agent: string, report: string) => [text(report), text(`agentId: ${agent} (use SendMessage with to: '${agent}' to continue this agent)\n<usage>subagent_tokens: 10\ntool_uses: 1\nduration_ms: 100</usage>`)];

// The harness's notification that an agent stopped, a text of its own, with the call that launched it where it says one.
export const notification = (agent: string, status: string, call?: string, result = "Done.") =>
  text(
    `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>${agent}</task-id>\n${call === undefined ? "" : `<tool-use-id>${call}</tool-use-id>\n`}<status>${status}</status>\n<result>${result}</result>\n</task-notification>\n</system-reminder>`,
  );
