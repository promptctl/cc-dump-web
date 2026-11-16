import { describe, expect, it } from "vitest";
import { linesOf, type Fact } from "./lines.ts";

// A fact: step `step`, traced `t<step>`, sending `messages` messages, leaving step `from` after the whole of it or inside
// what it added.
const first = (step: number, messages = 1): Fact => ({ step, trace: `t${step}`, left: undefined, messages });
const whole = (step: number, from: number, messages: number): Fact => ({ step, trace: `t${step}`, left: { step: from, whole: true }, messages });
const inside = (step: number, from: number, messages: number): Fact => ({ step, trace: `t${step}`, left: { step: from, whole: false }, messages });
// Each step's line, and for a branch the step it left from.
const lines = (facts: Fact[]) => linesOf(facts).map(({ line, branch }) => (branch === undefined ? line : `${line} off ${branch.from}`));

describe("linesOf", () => {
  it("keeps a thread whose every request continues the last on its main line", () => {
    expect(lines([first(1), whole(2, 1, 3), whole(3, 2, 5)])).toEqual(["thread:t1", "thread:t1", "thread:t1"]);
  });

  it("keeps a side question on the main line until the thread's next request leaves it out, then makes it a branch", () => {
    const facts = [first(1), whole(2, 1, 3), whole(3, 2, 5)];
    expect(lines(facts)).toEqual(["thread:t1", "thread:t1", "thread:t1"]);
    expect(lines([...facts, whole(4, 2, 5)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 2", "thread:t1"]);
  });

  it("makes the thread's next turn, when its message begins as a side question's did, the line's once it is continued", () => {
    const facts = [first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 3, 5)];
    // The turn leaves inside the question's message: until a request says which, the turn is the branch.
    expect(lines(facts)).toEqual(["thread:t1", "thread:t1", "thread:t1", "branch:t4 off 3"]);
    expect(lines([...facts, whole(5, 4, 7)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 2", "thread:t1", "thread:t1"]);
    // Continued after the line went on, a branch stays one.
    expect(lines([...facts, whole(5, 3, 7), whole(6, 4, 7)])).toEqual(["thread:t1", "thread:t1", "thread:t1", "branch:t4 off 3", "thread:t1", "branch:t4 off 3"]);
  });

  it("names the line a continued branch takes over by its first request, when its sibling began that line", () => {
    expect(lines([first(1), inside(2, 1, 1), whole(3, 1, 3), inside(4, 2, 1), whole(5, 4, 3)])).toEqual([
      "thread:t1",
      "branch:t2 off 1",
      "thread:t1",
      "branch:t4 off 2",
      "branch:t4 off 2",
    ]);
  });

  it("leaves the requests of a continued branch after the one continued, which the request does not resend, a branch", () => {
    expect(lines([first(1), whole(2, 1, 3), inside(3, 2, 3), inside(4, 3, 5), whole(5, 3, 5)])).toEqual([
      "thread:t1",
      "branch:t2 off 1",
      "thread:t1",
      "branch:t4 off 3",
      "thread:t1",
    ]);
  });

  it("makes turns a rewind leaves behind a branch off the step it resends", () => {
    expect(lines([first(1), whole(2, 1, 3), whole(3, 2, 5), whole(4, 1, 3), whole(5, 4, 5)])).toEqual(["thread:t1", "branch:t2 off 1", "branch:t2 off 1", "thread:t1", "thread:t1"]);
  });

  it("makes a compaction, which resends the last request without its reply, a branch, and the thread goes on past it", () => {
    // As the recording has it: the compaction leaves inside the last request's own message, sending as many messages.
    expect(lines([first(1), whole(2, 1, 3), inside(3, 2, 3), whole(4, 2, 5)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 2", "thread:t1"]);
  });

  it("makes a twin a branch of its own, each twin's requests on its own line, whichever arrives first", () => {
    expect(lines([first(1), inside(2, 1, 1), whole(3, 1, 3), whole(4, 2, 3)])).toEqual(["thread:t1", "branch:t2 off 1", "thread:t1", "branch:t2 off 1"]);
    expect(lines([first(1), whole(2, 1, 3), inside(3, 1, 1), whole(4, 3, 3)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 1", "branch:t3 off 1"]);
  });

  it("makes a side request with the thread's first message and a system prompt of its own a branch, and the thread goes on", () => {
    expect(lines([first(1), whole(2, 1, 3), inside(3, 1, 1), whole(4, 2, 5)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 1", "thread:t1"]);
  });

  it("makes an edit in place the line went on without a branch off where the edit left the line", () => {
    expect(lines([first(1), whole(2, 1, 3), inside(3, 1, 5), whole(4, 2, 5)])).toEqual(["thread:t1", "thread:t1", "branch:t3 off 1", "thread:t1"]);
  });

  it("keeps a request that edits the line's history and carries it on past its last request on the line", () => {
    expect(lines([first(1), whole(2, 1, 3), inside(3, 1, 5), whole(4, 3, 7)])).toEqual(["thread:t1", "thread:t1", "thread:t1", "thread:t1"]);
  });

  it("places each thread's requests on its own lines, the threads interleaved", () => {
    expect(lines([first(1), first(2), whole(3, 1, 3), inside(4, 2, 1), whole(5, 3, 5)])).toEqual(["thread:t1", "thread:t2", "thread:t1", "branch:t4 off 2", "thread:t1"]);
  });
});
