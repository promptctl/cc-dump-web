import type { Header } from "@cc-dump/proxy/format";
import { headerValues } from "./body.ts";

// [LAW:one-source-of-truth] What Claude Code says on the wire about its agents, read here alone: who sent a request,
// the agent a tool's result names, and the notification that an agent stopped (docs/design/claude-code-wire.md). The
// formatter states these on the blocks it makes, and the history and the checker read them there.

// [LAW:types-are-the-program] Who sent a request: the main agent, whose requests carry no agent header; a subagent, by
// its `x-claude-code-agent-id`, with the agent its `x-claude-code-parent-agent-id` names when another subagent launched
// it; or a sender the request does not say, `why`: its head was not recorded, or its headers contradict each other.
export type Sender = { kind: "main" } | { kind: "agent"; id: string; parent: string | undefined } | { kind: "unread"; why: string };

export function senderOf(head: { headers: Header[] } | undefined): Sender {
  if (head === undefined) return { kind: "unread", why: "head not recorded" };
  const ids = headerValues(head.headers, "x-claude-code-agent-id");
  const parents = headerValues(head.headers, "x-claude-code-parent-agent-id");
  if (ids.length === 0) return parents.length === 0 ? { kind: "main" } : { kind: "unread", why: "a parent agent header with no agent header" };
  const [id] = ids;
  if (ids.length > 1 || id === "") return { kind: "unread", why: "agent header repeated or empty" };
  if (parents.length === 0) return { kind: "agent", id: id!, parent: undefined };
  const [parent] = parents;
  if (parents.length > 1 || parent === "" || parent === id) return { kind: "unread", why: "parent agent header repeated, empty or naming the agent itself" };
  return { kind: "agent", id: id!, parent };
}

// The agent a tool's result names, by the texts of its content in order. An Agent call launched in the background is
// answered as the agent starts, its first text opening with the launch and the agent's id on the next line. One run in
// the foreground is answered when it returns, its last text ending with the agent's id, the ways to reach it, and the
// usage it took: a text of its own, or the end of a report that is a single text (Claude Code 2.1.299). What another
// tool returns can quote either, so a result names an agent only for the call that launched it (view/history.ts).
const background = /^Async agent launched successfully\.[^\n]*\nagentId: ([\w-]+) \(internal ID/;
const foreground = /(?:^|\n)agentId: ([\w-]+)(?: \([^\n]*\))?(?:\n[^\n]*)*?\n<usage>subagent_tokens: \d+\ntool_uses: \d+\nduration_ms: \d+<\/usage>$/;
export function namedIn(texts: readonly string[]): string | undefined {
  return background.exec(texts[0] ?? "")?.[1] ?? foreground.exec(texts.at(-1) ?? "")?.[1];
}

// [LAW:types-are-the-program] That an agent stopped, as the harness tells its caller: the agent, by its `<task-id>`,
// how it ended, by its `<status>`, and the call that launched it, by its `<tool-use-id>`, where it says one.
export type Notice = { agent: string; status: string; call: string | undefined };

// The notice a text is: one whose whole is one system reminder holding a `<task-notification>`, as the harness sends
// each, a text block of its own. A person's text that quotes one has text of its own around it, so it is none.
const notification = /^\s*<system-reminder>\n(?:(?!<\/system-reminder>)[\s\S])*?<task-notification>((?:(?!<\/system-reminder>)[\s\S])*?)<\/task-notification>\s*<\/system-reminder>\s*$/;
const tag = (inner: string, name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(inner)?.[1];
export function noticeIn(text: string): Notice | undefined {
  const inner = notification.exec(text)?.[1];
  if (inner === undefined) return undefined;
  const agent = tag(inner, "task-id");
  const status = tag(inner, "status");
  return agent === undefined || status === undefined ? undefined : { agent, status, call: tag(inner, "tool-use-id") };
}
