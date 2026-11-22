import { describe } from "./describe.ts";
import { outcomes, type Ending } from "./ending.ts";
import { Malformed } from "./failure.ts";
import { fields, jsonObject, parseJson } from "./json.ts";
import { parseTraceId, type TraceId } from "./trace.ts";

// A part's log as the logs panel reads it (docs/design/01-features.md, F9). Imports nothing that needs node, so the UI's
// parser is this one.

// [LAW:types-are-the-program] How much a line asks of its reader, most first: work that failed, work its server cut
// short by stopping, and work that ended, as it should or by its client leaving, which is how every stream ends.
export const levels = ["error", "warn", "info"] as const;
export type Level = (typeof levels)[number];

// [LAW:one-source-of-truth] Every event carries how its unit of work ended (a request's, `requestEnding`), so its level
// is read off that, never written beside it.
export function levelOf(outcome: Ending["outcome"]): Level {
  switch (outcome) {
    case "error":
      return "error";
    case "stopped":
      return "warn";
    case "aborted":
    case "ok":
      return "info";
  }
}

// A logged event: the part that wrote it, the unit of work and its trace, when it started and how long it took, how it
// ended, and every other fact on it.
export type LoggedEvent = Ending & { service: string; event: string; trace_id: TraceId; started_at: string; duration_ms: number; facts: Record<string, unknown> };

// Where a line is: line `seq` of the part's process `run`, numbered from 0 as the process writes them.
export type LinePosition = { run: string; seq: number };

// A line as `GET /logs` sends it: its position, and its event, or, for one this build cannot read, its text and why not.
export type LogLine = LinePosition & ({ event: LoggedEvent } | { unread: string; error: string });

// A line this build cannot read is an error: what the line said is not seen.
export function lineLevel(line: LogLine): Level {
  return "event" in line ? levelOf(line.event.outcome) : "error";
}

// The position a line's Server-Sent Events id, `run:seq`, names; undefined for an id that names none.
export function positionOf(id: string): LinePosition | undefined {
  const [, run, seq] = /^([0-9a-f]+):(\d+)$/.exec(id) ?? [];
  return run === undefined ? undefined : { run, seq: Number(seq) };
}

// [LAW:parse-dont-validate] The line whose event is `data` and whose id is `id`. An id that names no line is no log's,
// and throws; an event that does not parse taints no other line, so it is this one's, unread, in its place among them.
export function parseLogLine(data: string, id: string): LogLine {
  const position = positionOf(id);
  if (position === undefined) throw new Malformed(`log line: id ${JSON.stringify(id)} is not run:seq`);
  try {
    return { ...position, event: parseLoggedEvent(data) };
  } catch (error) {
    return { ...position, unread: data, error: describe(error) };
  }
}

function parseLoggedEvent(json: string): LoggedEvent {
  const event = jsonObject(parseJson(json, "log line"), "log line");
  const f = fields(event, "log line");
  const logged = {
    service: f.string("service"),
    event: f.string("event"),
    trace_id: f.parsed("trace_id", parseTraceId),
    started_at: f.string("started_at"),
    duration_ms: f.read("duration_ms", (value) => typeof value === "number", "a number"),
  };
  const ending = f.oneOf("outcome", outcomes);
  const placed = ending === "error" ? { ...logged, outcome: ending, error: f.string("error") } : { ...logged, outcome: ending };
  // The fields the event has a place of its own for are those just read; the rest are its facts.
  return { ...placed, facts: Object.fromEntries(Object.entries(event).filter(([name]) => !Object.hasOwn(placed, name))) };
}
