import { expect, it } from "vitest";
import { asLine, launchSession } from "./format.ts";

const l = (text: string) => asLine(text, "test line");

it("launches in the session the last launch asked for while tmux has it, and otherwise in tmux's first", () => {
  expect(launchSession({ settings: { session: l("play"), command: l("claude") }, sessions: [l("work"), l("play")] })).toBe("play");
  expect(launchSession({ settings: { session: l("gone"), command: l("claude") }, sessions: [l("work"), l("play")] })).toBe("work");
  expect(launchSession({ settings: { session: null, command: l("claude") }, sessions: [l("work")] })).toBe("work");
});
