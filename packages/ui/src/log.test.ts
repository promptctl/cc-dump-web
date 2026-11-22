import type { LogLine } from "@cc-dump/log/line";
import { workEvent as event } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { pageLog } from "./log.ts";

describe("the page's log", () => {
  it("hands a reader the lines it kept, then each one written, as the UI's lines in the parts' shape, until the reader leaves", () => {
    const { log, read } = pageLog(2);
    ["first", "second", "third"].forEach((name) => log(event(name)));
    const lines: LogLine[] = [];
    const leave = new AbortController();
    read((line) => lines.push(line), leave.signal);
    log(event("fourth"));
    leave.abort();
    log(event("fifth"));
    // The first line was let go to keep two; the reader sees the gap in the numbers, as it would a part's.
    expect(lines.map((line) => ("event" in line ? [line.seq, line.event.service, line.event.event] : line))).toEqual([
      [1, "ui", "second"],
      [2, "ui", "third"],
      [3, "ui", "fourth"],
    ]);
    expect(new Set(lines.map(({ run }) => run)).size).toBe(1);
  });

  it("numbers each page's lines under a run of its own, so the panel reads a reloaded page's anew", () => {
    const runOf = () => {
      const { log, read } = pageLog();
      log(event("one"));
      let run: string | undefined;
      read((line) => (run = line.run), new AbortController().signal);
      return run;
    };
    expect(runOf()).not.toBe(runOf());
  });

  it("throws the reason of a signal aborted before the read begins, and hands that reader nothing", () => {
    const { log, read } = pageLog();
    log(event("one"));
    const left = new AbortController();
    left.abort(new Error("gone"));
    const lines: LogLine[] = [];
    expect(() => read((line) => lines.push(line), left.signal)).toThrow("gone");
    log(event("two"));
    expect(lines).toEqual([]);
  });
});
