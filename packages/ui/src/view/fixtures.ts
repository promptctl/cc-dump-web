import type { Header, RecordedEvent } from "@cc-dump/proxy/format";

// Recorded traffic for the view's tests: Messages requests as Claude Code sends them, with the headers that say who
// sent each (docs/design/claude-code-wire.md), replies, and the blocks that tie and stop a subagent.

export const timestamp = "2026-11-15T14:00:00.000Z";
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

// Who sends a request: the main agent, by default, or a subagent, by its id, and the subagent that launched it.
export type From = { agent: string; parent?: string };
const headersOf = (from: From | undefined): Header[] =>
  from === undefined ? [] : [["x-claude-code-agent-id", from.agent], ...(from.parent === undefined ? [] : ([["x-claude-code-parent-agent-id", from.parent]] satisfies Header[]))];

export const request = (trace_id: string, body: unknown, from?: From): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages?beta=true", http_version: "1.1", headers: headersOf(from) },
  { timestamp, trace_id, type: "request_body", base64: base64(body) },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
// A reply, which ends its turn unless it says why else it stopped, and whose exchange ends at `ended`.
export const reply = (trace_id: string, content: unknown[], stop_reason = "end_turn", ended = timestamp): RecordedEvent[] => [
  { timestamp, trace_id, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
  { timestamp, trace_id, type: "response_body", base64: base64({ id: `msg_${trace_id}`, type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) },
  { timestamp, trace_id, type: "response_trailers", headers: [] },
  { timestamp: ended, trace_id, type: "end", outcome: "ok" },
];

export const text = (text: string) => ({ type: "text", text });
export const user = (...content: unknown[]) => ({ role: "user", content });
export const assistant = (...content: unknown[]) => ({ role: "assistant", content });

// A tool's call, an Agent call that launches a subagent with `prompt`, and a Skill call.
export const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
export const launch = (id: string, prompt: string, type = "Explore") => toolUse(id, "Agent", { description: "Look", prompt, subagent_type: type });
export const skill = (id: string, name: string) => toolUse(id, "Skill", { skill: name });
// A tool's result, and an Agent call's as a background launch's arrives, naming the agent.
export const result = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
export const launched = (id: string, agent: string) =>
  result(id, `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agent} (internal ID - do not mention to user.)\nThe agent is working in the background.`);
// A foreground agent's result, as it returns: its report, then the trailer that names it.
export const returned = (id: string, agent: string, report: string) =>
  result(id, [text(report), text(`agentId: ${agent} (use SendMessage with to: '${agent}', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 5\ntool_uses: 1\nduration_ms: 9</usage>`)]);
// The harness's notification that an agent stopped, naming the call that launched it where `call` is given.
export const stopped = (agent: string, call?: string) =>
  text(
    `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>${agent}</task-id>\n${call === undefined ? "" : `<tool-use-id>${call}</tool-use-id>\n`}<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>\n</system-reminder>`,
  );
