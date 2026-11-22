// The event every part writes and the one writer of it, importing nothing that needs node, so the UI writes its own
// events through it as the proxy and the app server write theirs.
import type { Ending } from "./ending.ts";
import type { Json } from "./json.ts";
import { mintTraceId, type TraceId } from "./trace.ts";

// [LAW:nothing-unseen] One wide event per unit of work, carrying the observability floor's default
// fields. Parts add facts beside them and never rename them; `service` is added by the sink, and `unit` names the unit
// of work a `failure` is of (`unitOfWork`).
// [LAW:types-are-the-program] A fact is what JSON says (a fact left undefined is not written), so every event encodes.
export type Event = {
  event: string;
  trace_id: TraceId;
  started_at: string;
  duration_ms: number;
  service?: never;
  unit?: string;
  [fact: string]: Json | undefined;
} & Ending;
export type Log = (event: Event) => void;

// The export edge: one JSON line per event, written wherever the entry point's `write` sends it.
export function createLog(service: string, write: (line: string) => void): Log {
  return (event) => write(`${JSON.stringify({ service, ...event })}\n`);
}

// A part's facts about a unit of work: any name but the floor's, read off `Event`.
type FloorField = keyof { [K in keyof Event as string extends K ? never : K]: unknown };
export type Facts = { [fact: string]: Json | undefined } & { [K in FloorField]?: never };

// The floor's span fields, for any unit of work a part times itself: one that begins a trace of its own, or one inside
// another's trace (a request's recording), joining it. Two entries, so a span that joins a trace names the trace it
// joins, and no call mints one for want of an argument.
export function startTrace() {
  return startSpan(mintTraceId());
}

// The floor's span fields, which `end` gives as its unit of work ends.
export type Span = { trace_id: TraceId; end: () => { trace_id: TraceId; started_at: string; duration_ms: number } };

export function startSpan(trace_id: TraceId): Span {
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { trace_id, end: () => ({ trace_id, started_at, duration_ms: performance.now() - started }) };
}

// [LAW:single-enforcer] The units of work a platform writes, over how it renders an error an event carries
// (`describeError`): node's, which redacts what node's errors carry (index.ts), or the browser's. The writer is the
// same on both; only the words of an error are the platform's.
export function unitsOf(describeError: (error: unknown) => string) {
  // The ending of work that failed with `error`.
  const failed = (error: unknown): Ending => ({ outcome: "error", error: describeError(error) });

  // [LAW:single-enforcer] A unit of work's one owner of how it ended, and so the one writer of its events. `end` says how
  // the work itself reached its end; the first failure reported while the work runs (a request's, an upgrade's, a
  // recording's) stands over that. A unit ends once: where several paths race to end one (a read caught up, failed, or
  // cut by its request), the first is its ending and a later one changes nothing.
  // [LAW:nothing-unseen] A unit's first reported failure is always written, and a later one never: work that counts its
  // failures (a recording's writes) counts them on its event. Reported after the end, by work that goes on once its unit
  // has ended (a route still running when its client left, a file read under way as its reader leaves), the first is a
  // `failure` event of its own. Nothing waits on that work: its end has no bound, and `close` waits on `ended`. The
  // `failure` carries the unit's facts and names the `unit` it is of, in its trace, timed from that unit's start; the
  // unit's own event stands as written.
  // [LAW:no-ambient-temporal-coupling] `end` measures all the event carries (the span, the facts `found` reads off the
  // work's end) while the unit is still open, so a measure that throws leaves it open for the failure its caller then
  // gives, and a failure reported while it measures is its ending. Only then is it ended, `ended` resolved, and the event
  // written, so whatever `log` does, a `log` that throws included (createLog's writes do not), the write surfaces as
  // itself, is never followed by a second write, and leaves nothing waiting on `ended`.
  // `judged` is how the event reads the unit's ending, where it judges more than `ended` says: a request's, by its status.
  function unitOfWork(log: Log, event: string, facts: Facts, span: Span, judged: (ending: Ending) => Ending = (ending) => ending) {
    let failure: Ending | undefined;
    let open = true;
    const { promise: ended, resolve } = Promise.withResolvers<Ending>();
    return {
      ended,
      fail: (error: unknown) => {
        if (failure !== undefined) return;
        failure = failed(error);
        if (!open) log({ event: "failure", unit: event, ...facts, ...span.end(), ...failure });
      },
      end: (reached: Ending, found: () => Facts = () => ({})) => {
        if (!open) return;
        const measured = { ...span.end(), ...found() };
        const ending = failure ?? reached;
        const written: Event = { event, ...facts, ...measured, ...judged(ending) };
        open = false;
        resolve(ending);
        log(written);
      },
    };
  }

  // A synchronous unit of work done outside any request, such as a part's setup: its event is written when
  // `work` returns, with the facts `found` reads off its result, or when either throws, and then the error is rethrown.
  // A promise is refused: its event would be written before the work had happened.
  function logged<T>(log: Log, event: string, facts: Facts, work: () => T extends PromiseLike<unknown> ? never : T, found: (result: T) => Facts = () => ({})): T {
    const unit = unitOfWork(log, event, facts, startTrace());
    try {
      const result = work();
      unit.end({ outcome: "ok" }, () => found(result));
      return result;
    } catch (error) {
      unit.end(failed(error));
      throw error;
    }
  }

  // An asynchronous unit of work in the trace `trace_id` names: its event is written once `work` settles, with the facts
  // `found` reads off its result, or when it rejects, and then the error is rethrown.
  async function loggedIn<T>(log: Log, trace_id: TraceId, event: string, facts: Facts, work: () => Promise<T>, found: (result: T) => Facts = () => ({})): Promise<T> {
    const unit = unitOfWork(log, event, facts, startSpan(trace_id));
    try {
      const result = await work();
      unit.end({ outcome: "ok" }, () => found(result));
      return result;
    } catch (error) {
      unit.end(failed(error));
      throw error;
    }
  }

  // A unit of work, inside another's trace, that something else did and timed, reported once it has ended: it took
  // `duration_ms`, up to now, and ended as `ending` says.
  function loggedAfter(log: Log, trace_id: TraceId, event: string, facts: Facts, duration_ms: number, ending: Ending) {
    const span: Span = { trace_id, end: () => ({ trace_id, started_at: new Date(Date.now() - duration_ms).toISOString(), duration_ms }) };
    unitOfWork(log, event, facts, span).end(ending);
  }

  return { failed, unitOfWork, logged, loggedIn, loggedAfter };
}
