import { asError, describe } from "@cc-dump/log/describe";
import { startTrace, type Log } from "@cc-dump/log/event";
import type { RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import { refusedAt, type Connection } from "./connection/connection.ts";
import { add, type ByTrace, type Settled } from "./exchanges.ts";
import { createFormatter, type FormattedExchange } from "./format/format.ts";
import { failed, unitOfWork } from "./log.ts";
import { recording, useExchanges } from "./store.ts";

// The recording open (docs/design/01-features.md, F7), by its name, or none: a tab that has launched no agent and opened no
// recording shows neither.
export type OpenRecording = string | null;

// [LAW:types-are-the-program] Where a read stands: none, with no recording open; reading the recording open, by its name,
// until it ends or fails. A recording the proxy run is writing ends only for a reader that leaves, and one it is not
// writing ends at its last event: so a read of an agent's recording ends when the proxy restarts, and a read begun after
// the agent's next request reaches the new proxy follows it again. A new read is begun by a mount, a reload, or opening
// a recording.
export type Reading =
  | { state: "none" }
  | { state: "reading"; name: string }
  | { state: "ended"; name: string; end: RecordingEnd }
  | { state: "failed"; error: Error };
// Where a read stands once it has ended.
type Finished = Extract<Reading, { state: "ended" | "failed" }>;

// Where a read shows what it has read: its exchanges formatted, in the order they began, each time they change.
export type Sink = (formatted: FormattedExchange[]) => void;

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// [LAW:types-are-the-program] An exchange that has ended and been formatted, as the read holds it from then on
// (exchanges.ts, `Settled`): what the formatter made of it, nothing for one it does not show. It holds none of the
// exchange's events, so a read holds a recording's bodies only while the exchanges that sent them run, and the
// formatter is never handed an exchange whose bodies are gone.
type Shown = Settled<FormattedExchange[]>;

// Where a read of `open` stands as it begins: reading it, or none.
const begun = (open: OpenRecording): Reading => (open === null ? { state: "none" } : { state: "reading", name: open });

// Reads the recording open into `sink` from its start, reporting where the read stands to `changed`, until `signal`
// aborts it. Whichever recording it is, it is the one read (docs/design/01-features.md, "One path to the screen"). With none
// open it reads nothing.
// [LAW:single-enforcer] The read folds each event into its exchange as it arrives (exchanges.ts, `add`), so an event
// that breaks the shape the proxy writes fails the read, naming where in the recording it ends, and ends the
// connection's read of it: what follows it cannot be trusted to be the recording.
// [LAW:no-ambient-temporal-coupling] The read owns its batch: exchanges changed between frames are shown in one call at
// the next, because catching up delivers thousands of events in quick succession and one format and render each would
// be quadratic. Each frame formats the read's exchanges and hands them to `sink`, and the events after it leave them as
// they are: the formatter makes anew each exchange an event changes. An exchange that has ended is formatted once more,
// and the read holds what it showed in its place (exchanges.ts, `Settled`), so it holds what its exchanges made, not
// every body its recording sends.
// [LAW:one-source-of-truth] The formatter is the read's own and lives as long as the read. The read's end is its own
// signal, `reading`: it aborts on `signal`, and as the read ends, refused, ended or failed, once it has shown what is
// pending (`end`). Its abort cancels the frame, and the connection delivers nothing after it, so no frame and no event
// of the read comes after its end.
// [LAW:no-silent-failure] A formatter that throws on what it was given ends the read as failed, with what it threw,
// since the throw comes from a frame or from the step that ends the read, which no caller catches.
// [LAW:nothing-unseen] A read is a unit of work of the UI's, written to `log` as `recording_read` as it ends: ended,
// with the end the proxy gave, failed, with its failure, or left by its reader (aborted), with the exchanges it read.
// A signal already aborted throws its reason, as the connection's read does, before the read begins, so no read is
// shown or written: that is the one throw the connection's read has, so a read begun reaches one of its endings.
export function readRecording(
  connection: Pick<Connection, "read">,
  log: Log,
  open: OpenRecording,
  sink: Sink,
  frames: Frames,
  signal: AbortSignal,
  changed: (reading: Reading) => void,
) {
  signal.throwIfAborted();
  sink([]);
  // Reported as the read begins, so an end or a failure the read reports as it begins is the last state.
  changed(begun(open));
  if (open === null) return;
  const byTrace: ByTrace<Shown> = new Map();
  const read = unitOfWork(log, "recording_read", { name: open }, startTrace());
  const exchanges = () => ({ exchanges: byTrace.size });
  signal.addEventListener("abort", () => read.end({ outcome: "aborted" }, exchanges), { once: true });
  const format = createFormatter();
  const flush = () => {
    const frame: FormattedExchange[] = [];
    byTrace.forEach((held, trace) => {
      switch (held.state) {
        case "settled":
          return void frame.push(...held.shown);
        case "open":
          return void frame.push(...format([held.exchange]));
        case "ended": {
          const shown = format([held.exchange]);
          frame.push(...shown);
          byTrace.set(trace, { state: "settled", shown });
        }
      }
    });
    sink(frame);
  };
  // The one frame pending, by the function that cancels it: scheduled by the first event after a frame, none once it
  // has run.
  let frame: (() => void) | undefined;
  const ended = new AbortController();
  const reading = AbortSignal.any([signal, ended.signal]);
  reading.addEventListener("abort", () => frame?.());
  // Shows what is pending, and says what showing it threw, if it threw.
  const show = (): Error | undefined => {
    try {
      flush();
    } catch (error) {
      return asError(error);
    }
  };
  const finish = (outcome: Finished) => {
    if (outcome.state === "ended") read.end({ outcome: "ok" }, () => ({ ...exchanges(), ...outcome.end }));
    else read.end(failed(outcome.error), exchanges);
    ended.abort();
    changed(outcome);
  };
  // [LAW:no-silent-failure] Ends the read in `outcome` once it has shown what is pending. When showing it throws too, the
  // read failed in what showed it: the failed outcome heads the message, its whole chain said there, and the failure of
  // showing is the `cause`, so neither replaces the other.
  const end = (outcome: Finished) => {
    const failure = show();
    if (failure === undefined) return finish(outcome);
    finish({ state: "failed", error: outcome.state === "failed" ? new Error(`${describe(outcome.error)}, and showing what it read failed`, { cause: failure }) : failure });
  };
  const shownAtFrame = () => {
    frame = undefined;
    const failure = show();
    if (failure !== undefined) finish({ state: "failed", error: failure });
  };
  connection.read(
    open,
    {
      event: (event, offset) => {
        const placed = add(byTrace, event);
        if (typeof placed === "string") return end({ state: "failed", error: new Error(open, { cause: refusedAt(offset, placed) }) });
        frame ??= frames(shownAtFrame);
      },
      end: (outcome) => end({ state: "ended", name: open, end: outcome }),
      failed: (error) => end({ state: "failed", error }),
    },
    reading,
  );
}

// The recording on screen, by its name: the one being read or read to its end. None while none is open, or the read
// failed.
export function onScreen(reading: Reading): string | undefined {
  return reading.state === "reading" || reading.state === "ended" ? reading.name : undefined;
}

const animationFrames: Frames = (callback) => {
  const frame = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(frame);
};

// The recording open, read into the store for as long as the component using it is mounted, and read again from its
// start each time one is opened.
// [LAW:one-source-of-truth] A recording is opened again by its own name, which changes nothing in `open`: the store's
// `read` is what changes on every open, so it is what a read depends on. The read empties the exchanges with `show`,
// which leaves `read` as it was; were it `open`, the read would change its own dependency.
export function useRecording(connection: Connection, log: Log, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>(() => begun(open));
  const read = useExchanges((store) => store.read);
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, log, open, recording.show, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, log, open, read]);
  return reading;
}
