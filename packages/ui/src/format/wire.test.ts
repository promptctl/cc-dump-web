import { describe, expect, it } from "vitest";
import { senderOf } from "./wire.ts";

describe("senderOf", () => {
  const head = (...headers: [string, string][]) => ({ headers: [["Content-Type", "application/json"], ...headers] as [string, string][] });

  it("says the main agent sent a request with no agent header, and a subagent one with its id, by its parent where one launched it", () => {
    expect(senderOf(head())).toEqual({ kind: "main" });
    expect(senderOf(head(["X-Claude-Code-Agent-Id", "a1"]))).toEqual({ kind: "agent", id: "a1", parent: undefined });
    expect(senderOf(head(["x-claude-code-agent-id", "a2"], ["x-claude-code-parent-agent-id", "a1"]))).toEqual({ kind: "agent", id: "a2", parent: "a1" });
  });

  it("says a sender is not read where the head was not recorded or its headers contradict each other", () => {
    const unread = (sender: ReturnType<typeof senderOf>) => sender.kind;
    expect(senderOf(undefined)).toEqual({ kind: "unread", why: "head not recorded" });
    expect(unread(senderOf(head(["x-claude-code-parent-agent-id", "a1"])))).toBe("unread");
    expect(unread(senderOf(head(["x-claude-code-agent-id", "a1"], ["x-claude-code-agent-id", "a2"])))).toBe("unread");
    expect(unread(senderOf(head(["x-claude-code-agent-id", ""])))).toBe("unread");
    expect(unread(senderOf(head(["x-claude-code-agent-id", "a1"], ["x-claude-code-parent-agent-id", "a1"])))).toBe("unread");
    expect(unread(senderOf(head(["x-claude-code-agent-id", "a1"], ["x-claude-code-parent-agent-id", ""])))).toBe("unread");
  });
});
