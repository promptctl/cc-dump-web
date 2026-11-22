import { eventsWritten } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { viewLog, type StepTaken } from "./decisions.ts";
import type { Position } from "./position.ts";
import type { By, Stepped } from "./scroll.ts";

const end: Position = { at: "end" };
const inC: Position = { at: "row", key: "c", offset: 20 };
const inD: Position = { at: "row", key: "d", offset: 0 };

// A view's decisions written to a log the test reads.
function logged() {
  const { events, log } = eventsWritten();
  return { events, decisions: viewLog(log) };
}

// A step from the place `from`, the one `by` last moved, last written at 170, to what `next` says.
const stepped = (from: Position, by: By, next: Partial<Stepped>, cause: StepTaken["cause"] = "scroll"): StepTaken => ({
  cause,
  offset: 120,
  end: 250,
  kept: { position: from, written: 170, by },
  next: { position: from, written: 120, write: undefined, by, ...next } as Stepped,
});

describe("the view's decisions", () => {
  it("say which judgement replaced a kept place, and with what", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(inD, "view", { position: inC, by: "view", replaced: "read_ended" }, "change"));
    expect(events).toEqual([expect.objectContaining({ event: "place_replaced", outcome: "ok", from: inD, to: inC, why: "read_ended" })]);
  });

  it("write nothing for a step that leaves the place whose it was", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(inC, "view", { write: 300 }, "change"));
    decisions.stepped(stepped(inC, "reader", { position: inD }));
    expect(events).toEqual([]);
  });

  it("say that the view took an offset for the reader's as the view's place becomes the reader's, with what tells it from a clamp", () => {
    const { events, decisions } = logged();
    decisions.stepped(stepped(end, "view", { position: inC, by: "reader" }));
    expect(events).toEqual([expect.objectContaining({ event: "reader_scroll", from: end, to: inC, cause: "scroll", offset: 120, written: 170, end: 250 })]);
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

  it("write a hold of the moves as it begins and as it ends, on its own span in its own trace, once however often it is told", () => {
    const { events, decisions } = logged();
    decisions.held(undefined);
    decisions.held({ held: "place", read: "reading" });
    decisions.held({ held: "place", read: "reading" });
    decisions.held({ held: "place", read: "failed" });
    decisions.held(undefined);
    decisions.held(undefined);
    expect(events).toEqual([
      expect.objectContaining({ event: "moves_held", held: "place", read: "reading", outcome: "ok" }),
      expect.objectContaining({ event: "moves_freed", held: "place", read: "reading", outcome: "ok" }),
      expect.objectContaining({ event: "moves_held", held: "place", read: "failed", outcome: "ok" }),
      expect.objectContaining({ event: "moves_freed", held: "place", read: "failed", outcome: "ok" }),
    ]);
    // A hold's two events are of one span: begun at one time, the end timed from it.
    for (const [begun, freed] of [[events[0]!, events[1]!], [events[2]!, events[3]!]] as const) {
      expect([freed.trace_id, freed.started_at]).toEqual([begun.trace_id, begun.started_at]);
      expect(freed.duration_ms).toBeGreaterThanOrEqual(begun.duration_ms);
    }
    expect(events[2]!.trace_id).not.toBe(events[0]!.trace_id);
  });

  it("end a hold in force as the view goes, as left with it, and none once it is freed", () => {
    const { events, decisions } = logged();
    decisions.held({ held: "match", read: "reading" });
    decisions.close();
    decisions.close();
    expect(events.map(({ event, outcome }) => [event, outcome])).toEqual([
      ["moves_held", "ok"],
      ["moves_freed", "aborted"],
    ]);
    const freed = logged();
    freed.decisions.held({ held: "place", read: "reading" });
    freed.decisions.held(undefined);
    freed.decisions.close();
    expect(freed.events.map(({ event, outcome }) => [event, outcome])).toEqual([
      ["moves_held", "ok"],
      ["moves_freed", "ok"],
    ]);
  });
});
