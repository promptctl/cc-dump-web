import { expect, it } from "vitest";
import { launchSession, parseLauncher } from "./format.ts";

it("launches in the session the last launch asked for while tmux has it, and otherwise in tmux's first", () => {
  expect(launchSession({ settings: { session: "play", command: "claude" }, sessions: ["work", "play"] })).toBe("play");
  expect(launchSession({ settings: { session: "gone", command: "claude" }, sessions: ["work", "play"] })).toBe("work");
  expect(launchSession({ settings: { session: null, command: "claude" }, sessions: ["work"] })).toBe("work");
});

it("reads `GET /launch`'s settings as a message's field, passing over a setting another build reads", () => {
  const launcher = { settings: { session: "work", command: "claude", theme: "dark" }, sessions: ["work"] };
  expect(parseLauncher(JSON.stringify(launcher))).toEqual({ settings: { session: "work", command: "claude" }, sessions: ["work"] });
});

it("refuses a session tmux lists that is no line of text by its place in the list", () => {
  const launcher = { settings: { session: null, command: "claude" }, sessions: ["work", ""] };
  expect(() => parseLauncher(JSON.stringify(launcher))).toThrow('launcher: sessions: 1: must be a line of text that is not blank, got ""');
});
