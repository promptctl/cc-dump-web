import type { Header, RecordedEvent } from "@cc-dump/proxy/format";

// Recordings for the history's and the column's tests: requests and replies of the Messages API as the proxy records
// them, and the wire Claude Code speaks about its agents (docs/design/claude-code-wire.md).

export const timestamp = "2026-11-15T14:00:00.000Z";
const base64 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).toBase64();

// A request, sent `by` the agent its head names: the main agent's carries no agent id (format/wire.ts).
export const request = (trace_id: string, body: unknown, by: Header[] = []): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: by },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
// The head of a subagent's request: its id, and its parent's, where another subagent launched it.
export const by = (agent: string, parent?: string): Header[] => [["x-claude-code-agent-id", agent], ...(parent === undefined ? [] : [["x-claude-code-parent-agent-id", parent] satisfies Header])];

// A reply, which ends its turn unless it says why else it stopped, and its exchange's end.
export const reply = (trace_id: string, content: unknown[], stop_reason = "end_turn"): RecordedEvent[] => [
  { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { timestamp, trace_id, type: "response_body", base64: base64({ id: `msg_${trace_id}`, type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) },
  { timestamp, trace_id, type: "response_trailers", headers: [] },
  { timestamp, trace_id, type: "end", outcome: "ok" },
];

export const text = (text: string) => ({ type: "text", text });
export const user = (...content: unknown[]) => ({ role: "user", content });
export const assistant = (...content: unknown[]) => ({ role: "assistant", content });

// A call of a tool, the Agent tool's with the prompt it launches a subagent with, and a tool's result.
export const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
export const agentCall = (id: string, prompt: string) => toolUse(id, "Agent", { description: "Look", prompt, subagent_type: "Explore" });
export const result = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
// The result of an Agent call that launched `agent` in the background, as Claude Code words it.
export const launched = (id: string, agent: string) =>
  result(id, [text(`Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agent} (internal ID - do not mention to user.)\nThe agent is working in the background.`)]);
// The harness telling a caller that `agent`, launched by call `id`, stopped: a text block that is one system reminder.
export const notice = (agent: string, id: string) =>
  text(`<system-reminder>\n<task-notification>\n<task-id>${agent}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>\n</system-reminder>\n`);
