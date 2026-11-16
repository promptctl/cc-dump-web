import { expect, it } from "vitest";
import { launchSession } from "./format.ts";

it("launches in the session the last launch asked for while tmux has it, and otherwise in tmux's first", () => {
  expect(launchSession({ settings: { session: "play", command: "claude" }, sessions: ["work", "play"] })).toBe("play");
  expect(launchSession({ settings: { session: "gone", command: "claude" }, sessions: ["work", "play"] })).toBe("work");
  expect(launchSession({ settings: { session: null, command: "claude" }, sessions: ["work"] })).toBe("work");
});
