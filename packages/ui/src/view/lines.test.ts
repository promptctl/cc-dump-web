import { describe, expect, it } from "vitest";
import { followsOf, type Fact } from "./lines.ts";

// A fact: step `step`, sending `messages` messages, leaving step `from` after the whole of it or inside what it added, at
// the message `message`, which is the last it sends where none is said.
const first = (step: number, messages = 1): Fact => ({ step, left: undefined, messages });
const whole = (step: number, from: number, messages: number): Fact => ({ step, left: { step: from, whole: true, message: messages - 1 }, messages });
const inside = (step: number, from: number, messages: number, message = messages - 1): Fact => ({ step, left: { step: from, whole: false, message }, messages });

describe("followsOf", () => {
  it("has each request of a thread that resends the whole of the last follow it", () => {
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5)])).toEqual([undefined, 1, 2]);
  });

  it("has a side question and the turn after it, which leaves it out, both follow the step they resend", () => {
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), whole(4, 2, 5)])).toEqual([undefined, 1, 2, 2]);
  });

  it("has the turns after a rewind follow the step it resends, as the turns it left behind do", () => {
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), whole(4, 1, 3), whole(5, 4, 5)])).toEqual([undefined, 1, 2, 1, 4]);
  });

  it("has a request that leaves inside another's own message follow what that one follows", () => {
    // A compaction resends the last request without its reply; a turn whose message begins as a side question's did
    // leaves inside the question's.
    expect(followsOf([first(1), whole(2, 1, 3), inside(3, 2, 3), whole(4, 2, 5)])).toEqual([undefined, 1, 1, 2]);
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 3, 5)])).toEqual([undefined, 1, 2, 2]);
  });

  it("has a request that leaves inside another's reply follow what that one follows", () => {
    // Step 2's reply is its message 3, which step 4 sends another block at.
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 2, 5, 3)])).toEqual([undefined, 1, 2, 1]);
  });

  it("has a twin, which leaves in the thread's second message, follow nothing, whichever arrives first", () => {
    expect(followsOf([first(1), inside(2, 1, 1, 1), whole(3, 1, 3), whole(4, 2, 3)])).toEqual([undefined, undefined, 1, 2]);
    expect(followsOf([first(1), whole(2, 1, 3), inside(3, 1, 1, 1), whole(4, 3, 3)])).toEqual([undefined, 1, undefined, 3]);
  });

  it("has a request that edits its line's history and sends more than the line's last follow that last", () => {
    expect(followsOf([first(1), whole(2, 1, 3), inside(3, 1, 5, 0), whole(4, 3, 7)])).toEqual([undefined, 1, 2, 3]);
    // The line went on without it: the turn after step 2 follows step 2, as the edit does.
    expect(followsOf([first(1), whole(2, 1, 3), inside(3, 1, 5, 0), whole(4, 2, 5)])).toEqual([undefined, 1, 2, 2]);
  });

  it("has a request that leaves inside an edit follow the nearest step up whose reply comes before the message it leaves in", () => {
    // Step 4 edits the first message and follows step 3; step 5 leaves it at message 2, which is step 2's own.
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 1, 7, 0), inside(5, 4, 7, 2)])).toEqual([undefined, 1, 2, 3, 1]);
  });

  it("has an edit follow the turn that carried its line on, not the side question the turn's message began as", () => {
    const facts = [first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 3, 5), whole(5, 4, 7)];
    // The turn, step 4, is continued while the question, step 3, is still the line's last: the line is the turn's.
    expect(followsOf([...facts, inside(6, 2, 9, 2)])).toEqual([undefined, 1, 2, 2, 4, 5]);
    // Continued after the line went on past the question, the turn's requests are a line of their own.
    expect(followsOf([first(1), whole(2, 1, 3), whole(3, 2, 5), inside(4, 3, 5), whole(5, 3, 7), whole(6, 4, 7), inside(7, 2, 9, 2)])).toEqual([undefined, 1, 2, 2, 3, 4, 5]);
  });

  it("places each thread's requests among its own, the threads interleaved", () => {
    expect(followsOf([first(1), first(2), whole(3, 1, 3), inside(4, 2, 1, 1), whole(5, 3, 5)])).toEqual([undefined, undefined, 1, undefined, 3]);
  });
});
