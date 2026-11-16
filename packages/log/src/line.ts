import { outcomes, type Ending } from "./ending.ts";
import { fields, parseJson } from "./json.ts";

// A part's log as the logs panel reads it (docs/design/01-mvp.md, F9). Imports nothing that needs node, so the UI's
// parser is this one.

// [LAW:types-are-the-program] How much a line asks of its reader, most first: work that failed, work cut short (its
// client left, or its server stopped), and work that ended as it should.
export const levels = ["error", "warn", "info"] as const;
export type Level = (typeof levels)[number];

// [LAW:one-source-of-truth] Every event carries how its work ended, so its level is read off that, never written beside it.
export function levelOf(outcome: Ending["outcome"]): Level {
  switch (outcome) {
    case "error":
      return "error";
    case "aborted":
    case "stopped":
      return "warn";
    case "ok":
      return "info";
  }
}

// A logged event: the part that wrote it, the unit of work, when it started and how long it took, how it ended, and
// every other fact on it.
export type LoggedEvent = Ending & { service: string; event: string; started_at: string; duration_ms: number; facts: Record<string, unknown> };

// A line as `GET /logs` sends it: line `seq` of the part's process `run`, numbered from 0 as the process writes them.
export type LogLine = { run: string; seq: number; event: LoggedEvent };

// The fields a logged event has a place of its own for; the rest are its facts.
const named = new Set(["service", "event", "started_at", "duration_ms", "outcome", "error"]);

export function parseLogLine(json: string): LogLine {
  const line = fields(parseJson(json, "log line"), "log line");
  const f = fields(line.object("event"), "log line: event");
  const logged = {
    service: f.string("service"),
    event: f.string("event"),
    started_at: f.string("started_at"),
    duration_ms: f.read("duration_ms", (value) => typeof value === "number", "a number"),
    facts: Object.fromEntries(Object.entries(line.object("event")).filter(([name]) => !named.has(name))),
  };
  const ending = f.oneOf("outcome", outcomes);
  return {
    run: line.string("run"),
    seq: line.integer("seq"),
    event: ending === "error" ? { ...logged, outcome: ending, error: f.string("error") } : { ...logged, outcome: ending },
  };
}
