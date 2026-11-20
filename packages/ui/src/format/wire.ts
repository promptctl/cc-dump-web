import type { Header } from "@cc-dump/proxy/format";
import { headerValues } from "./body.ts";

// What Claude Code says on the wire about its agents (docs/design/claude-code-wire.md): who sent a request, the agent a
// tool's result names, and the stops a task notification tells. [LAW:one-source-of-truth] The one reader of this
// grammar: the formatter states what it reads on each exchange and block, and the history and the checker read those.

// [LAW:types-are-the-program] Who sent a request: the main agent, whose requests carry no agent id; a subagent, by the
// id its requests carry, and the agent that launched it where another subagent did; or, where the head that says it
// was not recorded or says it in a way no request of Claude Code's does, unknown, with why.
export type Sender = { kind: "main" } | { kind: "subagent"; id: string; parent: string | undefined } | { kind: "unknown"; why: string };

export function senderOf(headers: Header[] | undefined): Sender {
  if (headers === undefined) return { kind: "unknown", why: "the request's head was not recorded" };
  const ids = headerValues(headers, "x-claude-code-agent-id");
  const parents = headerValues(headers, "x-claude-code-parent-agent-id");
  if (ids.length > 1 || parents.length > 1) return { kind: "unknown", why: "the request names more than one agent as its sender or its parent" };
  const [id] = ids;
  const [parent] = parents;
  if (id === "" || parent === "") return { kind: "unknown", why: "the request names its sender or its parent as nothing" };
  if (id === undefined) return parent === undefined ? { kind: "main" } : { kind: "unknown", why: "the request names a parent agent but no agent of its own" };
  return { kind: "subagent", id, parent };
}

// The agent a tool's result names, from its texts. A background agent's result arrives as it starts: a text that opens
// `Async agent launched successfully.` and holds a line `agentId: <id> (internal ID…`. A foreground agent's arrives as it
// returns, its report and then a last text `agentId: <id> (use SendMessage…` ending with its `<usage>…</usage>`, a frame
// read from Claude Code 2.1.197's source that no recording holds yet. Any other result names none. Only a result of a
// call that launches an agent names one (view/history.ts): this reads the frame, not whose result it is.
const background = /^agentId: (\S+) \(internal ID/m;
const foreground = /^agentId: (\S+) \(use SendMessage[\s\S]*<usage>[\s\S]*<\/usage>\s*$/;
export function namedIn(texts: readonly string[]): string | undefined {
  const launched = texts.find((text) => text.startsWith("Async agent launched successfully."));
  return (launched === undefined ? undefined : background.exec(launched)?.[1]) ?? foreground.exec(texts.at(-1) ?? "")?.[1];
}

// What a task notification tells: the agent that stopped, and the call that launched it where it names one. A stop needs
// only the agent: a killed agent's notification, and some completed ones', name no call.
export type Notice = { agent: string; call: string | undefined };

// The notifications the harness's text holds, each a `<task-notification>` element on lines of its own, its task id the
// first thing it holds and its tool-use id, where it has one, the next. What an element holds after them, its summary
// and the agent's result, is the agent's text, so an id quoted there tells nothing. [LAW:single-enforcer] Only the
// harness's text is read so (format/injected.ts): what a person types is never a notification.
const element = /^<task-notification>\s*<task-id>([^<\s]+)<\/task-id>\s*(?:<tool-use-id>([^<\s]+)<\/tool-use-id>)?[\s\S]*?^<\/task-notification>/gm;
export const noticesIn = (text: string): Notice[] => [...text.matchAll(element)].map(([, agent, call]) => ({ agent: agent!, call }));
