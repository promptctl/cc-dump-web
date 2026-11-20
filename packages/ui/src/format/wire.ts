import type { Header } from "@cc-dump/proxy/format";
import { headerValues } from "./body.ts";

// What Claude Code states on the wire about its agents (docs/design/claude-code-wire.md): who sent a request, which agent
// an Agent call's result names, and which agents a task notification says stopped. [LAW:one-source-of-truth] The one
// reader of these, which the formatter states on each exchange and block and the checker (check/column.ts) reads too.

// [LAW:types-are-the-program] Who sent a request: the main agent, whose requests carry no agent id; a subagent, by its id
// and, where another subagent launched it, that one's; or no one known, for a request whose head was not recorded.
export type Sender = { kind: "main" } | { kind: "subagent"; id: string; parent: string | undefined } | { kind: "unrecorded" };

export function senderOf(head: { headers: Header[] } | undefined): Sender {
  if (head === undefined) return { kind: "unrecorded" };
  const [id] = headerValues(head.headers, "x-claude-code-agent-id");
  const [parent] = headerValues(head.headers, "x-claude-code-parent-agent-id");
  return id === undefined ? { kind: "main" } : { kind: "subagent", id, parent };
}

// The agent an Agent tool's result names, and how it ran: in the background, whose result arrives as it starts, or in
// the foreground, whose result is its report and arrives as it stops. As Claude Code 2.1.197 writes them: a background
// launch's text opens `Async agent launched successfully.` and names the agent on its next line; a foreground agent's
// report is followed by a text that names it and ends with its `<usage>`. An Explore or a Plan agent run in the
// foreground returns its report alone, which names no agent.
export type Named = { agent: string; ran: "background" | "foreground" };

const background = /^Async agent launched successfully\.\nagentId: (\S+) /;
const foreground = /^agentId: (\S+) \(use SendMessage[\s\S]*\n<usage>[\s\S]*<\/usage>$/;

// The agent the texts of a tool result's content name, in order, if they are either frame.
export function namedIn(texts: readonly string[]): Named | undefined {
  const launched = texts.length === 0 ? null : background.exec(texts[0]!);
  if (launched !== null) return { agent: launched[1]!, ran: "background" };
  const returned = texts.length < 2 ? null : foreground.exec(texts.at(-1)!);
  return returned === null ? undefined : { agent: returned[1]!, ran: "foreground" };
}

// A background agent's stop, as the harness tells its caller: the agent (`task-id`) and the Agent call that launched it
// (`tool-use-id`). [LAW:no-silent-failure] A notification whose ids do not read is a misfit, said with the stops.
export type Stop = { agent: string; call: string };
export type Notified = { stops: Stop[]; misfits: number };

const notification = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const idOf = (inner: string, tag: string) => new RegExp(`<${tag}>([^<\\s]+)</${tag}>`).exec(inner)?.[1];

// The notifications a text of the harness's holds.
export function notifiedIn(text: string): Notified {
  const stops: Stop[] = [];
  let misfits = 0;
  for (const [, inner] of text.matchAll(notification)) {
    const agent = idOf(inner!, "task-id");
    const call = idOf(inner!, "tool-use-id");
    if (agent === undefined || call === undefined) misfits++;
    else stops.push({ agent, call });
  }
  return { stops, misfits };
}
