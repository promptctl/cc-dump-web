import { expect, it } from "vitest";
import { launchSession, parseLaunch, type Session } from "./format.ts";

const work: Session = { name: "work", directories: ["/work"] };
const play: Session = { name: "play", directories: ["/play"] };

it("launches in the session the last launch asked for while tmux has it, and otherwise in tmux's first", () => {
  expect(launchSession({ settings: { session: "play", command: "claude" }, sessions: [work, play], home: "/home/u" })).toBe(play);
  expect(launchSession({ settings: { session: "gone", command: "claude" }, sessions: [work, play], home: "/home/u" })).toBe(work);
  expect(launchSession({ settings: { session: null, command: "claude" }, sessions: [work], home: "/home/u" })).toBe(work);
});

it.each([
  [undefined, "directory must be a line of text that is not blank, got undefined"],
  ["code/project", 'directory must be absolute, got "code/project"'],
  ["~/code", 'directory must be absolute, got "~/code"'],
])("refuses a launch in the directory %j", (cwd, reason) => {
  expect(() => parseLaunch(JSON.stringify({ session: "work", command: "claude", cwd }))).toThrow(reason);
});
