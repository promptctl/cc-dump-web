import { describe, expect, it } from "vitest";
import { senderOf } from "./wire.ts";

describe("senderOf", () => {
  it("reads who sent a request from its agent headers, whatever their case", () => {
    expect(senderOf([["X-Claude-Code-Session-Id", "s"]])).toEqual({ kind: "main" });
    expect(senderOf([["x-claude-code-agent-id", "a1"]])).toEqual({ kind: "subagent", id: "a1", parent: undefined });
    expect(senderOf([["X-Claude-Code-Agent-Id", "a2"], ["x-claude-code-parent-agent-id", "a1"]])).toEqual({ kind: "subagent", id: "a2", parent: "a1" });
  });

  it("says why it cannot tell who sent a request: no head recorded, an id sent twice or empty, or a parent with no agent", () => {
    expect(senderOf(undefined)).toEqual({ kind: "unknown", why: "the request's head was not recorded" });
    expect(senderOf([["x-claude-code-agent-id", "a1"], ["x-claude-code-agent-id", "a2"]]).kind).toBe("unknown");
    expect(senderOf([["x-claude-code-agent-id", ""]]).kind).toBe("unknown");
    expect(senderOf([["x-claude-code-parent-agent-id", "a1"]]).kind).toBe("unknown");
  });
});
