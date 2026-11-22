import { eventsWritten } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { viewLog, type Stepped } from "./decisions.ts";
import type { Position } from "./position.ts";

const end: Position = { at: "end" };
const inC: Position = { at: "row", key: "c", offset: 20 };
const inD: Position = { at: "row", key: "d", offset: 0 };

// A view's decisions written to a log the test reads, on a clock the test sets.
function logged() {
  const { events, log } = eventsWritten();
  let now = 0;
  return { events, decisions: viewLog(log, () => now), at: (ms: number) => (now = ms) };
}

// A step from the place `from`, last written at 170, to what `next` says.
const stepped = (from: Position, next: Partial<Stepped["next"]>, cause: Stepped["cause"] = "scroll"): Stepped => ({
  cause,
  offset: 120,
  end: 250,
  kept: { position: from, written: 170 },
  next: { position: from, write: undefined, by: "view", replaced: undefined, ...next },
});

describe("the view's decisions", () => {
  it("say which judgement replaced a kept place, and with what", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(inD, { position: inC, replaced: "read_ended" }, "change"));
    expect(events).toEqual([expect.objectContaining({ event: "place_replaced", outcome: "ok", from: inD, to: inC, why: "read_ended" })]);
  });

  it("write nothing for a step that keeps the place", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(inC, { write: 300 }, "change"));
    decisions.stepped(stepped(end, { by: "reader" }, "change"));
    expect(events).toEqual([]);
  });

  it("say once for each run of a reader's scrolls that the view took an offset for theirs, with what tells it from a clamp", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(end, { position: inC, by: "reader" }));
    decisions.stepped(stepped(inC, { position: inD, by: "reader" }));
    // The view's own steps between the scrolls, which keep the reader's place, leave the run going on.
    decisions.stepped(stepped(inD, {}, "change"));
    decisions.stepped(stepped(inD, { position: inC, by: "reader" }));
    expect(events).toEqual([expect.objectContaining({ event: "reader_scroll", from: end, to: inC, cause: "scroll", offset: 120, written: 170, end: 250 })]);
    // The view writes, so the next scroll the view takes for the reader's is a decision of its own.
    decisions.stepped(stepped(inC, { write: 40 }, "change"));
    decisions.stepped(stepped(inC, { position: inD, by: "reader" }));
    expect(events.map(({ event }) => event)).toEqual(["reader_scroll", "reader_scroll"]);
    // As does the view placing it: the end it went back to, with follow turned off since, becomes the place under it.
    decisions.stepped(stepped(inD, { position: end }, "choose"));
    decisions.stepped(stepped(end, { position: inD, replaced: "end_unfollowed" }, "change"));
    decisions.stepped(stepped(inD, { position: inC, by: "reader" }));
    expect(events.map(({ event }) => event)).toEqual(["reader_scroll", "reader_scroll", "place_replaced", "reader_scroll"]);
  });

  it("say why a current match was cleared, and a moment replaced by now", () => {
    const { events, decisions } = logged();
    decisions.matchCleared({ at: "gone", why: "step_unlisted", key: "t9/said" });
    decisions.momentReplaced({ at: "chosen", trace: "t3" }, { at: "gone", why: "read_ended" });
    expect(events).toEqual([
      expect.objectContaining({ event: "match_cleared", key: "t9/said", why: "step_unlisted" }),
      expect.objectContaining({ event: "moment_replaced", from: { at: "chosen", trace: "t3" }, why: "read_ended" }),
    ]);
  });

  it("write a hold of the moves as it begins and as it ends, timed from its beginning in its own trace, once however often it is told", () => {
    const { events, decisions, at } = logged();
    decisions.held(undefined);
    at(1000);
    decisions.held({ held: "place", read: "reading" });
    at(1500);
    decisions.held({ held: "place", read: "reading" });
    at(3400);
    decisions.held({ held: "place", read: "failed" });
    at(3500);
    decisions.held(undefined);
    decisions.held(undefined);
    expect(events).toEqual([
      expect.objectContaining({ event: "moves_held", held: "place", read: "reading" }),
      expect.objectContaining({ event: "moves_freed", held: "place", read: "reading", duration_ms: 2400 }),
      expect.objectContaining({ event: "moves_held", held: "place", read: "failed" }),
      expect.objectContaining({ event: "moves_freed", held: "place", read: "failed", duration_ms: 100 }),
    ]);
    expect(events[1]!.trace_id).toBe(events[0]!.trace_id);
    expect(events[3]!.trace_id).toBe(events[2]!.trace_id);
    expect(events[2]!.trace_id).not.toBe(events[0]!.trace_id);
  });
});
