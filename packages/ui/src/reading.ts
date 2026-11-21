import { asError } from "@cc-dump/log/describe";
import type { RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import { refusedAt, type Connection } from "./connection/connection.ts";
import { add, type ByTrace, type Ended, type Exchange } from "./exchanges.ts";
import { createFormatter, type FormattedExchange } from "./format/format.ts";
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

// Where a read shows what it has read: its exchanges formatted, in the order they began, each time they change.
export type Sink = (formatted: FormattedExchange[]) => void;

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// [LAW:types-are-the-program] An exchange that has ended and been formatted, as the read holds it from then on: its end,
// which refuses the events after it (exchanges.ts, `Ended`), and what the formatter made of it, nothing for one it does
// not show. It holds none of the exchange's events, so a read holds a recording's bodies only while the exchanges that
// sent them run, and the formatter is never handed an exchange whose bodies are gone.
type Settled = Ended & { shown: FormattedExchange[] };
const isSettled = (held: Exchange | Settled): held is Settled => "shown" in held;

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
// and the read holds what it showed in its place (`Settled`), so it holds what its exchanges made, not every body its
// recording sends.
// [LAW:one-source-of-truth] The formatter is the read's own and lives as long as the read. The read's end is its own
// signal, `reading`: it aborts on `signal`, and as the read ends, refused, ended or failed, once it has shown what is
// pending, by the frame's own step. Its abort cancels the frame, and the connection delivers nothing after it, so no
// frame and no event of the read comes after its end.
// [LAW:no-silent-failure] A formatter that throws on what it was given ends the read as failed, with what it threw,
// since the throw comes from a frame or from the step that ends the read, which no caller catches.
export function readRecording(connection: Pick<Connection, "read">, open: OpenRecording, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
  sink([]);
  // Reported as the read begins, so an end or a failure the read reports as it begins is the last state.
  changed(begun(open));
  if (open === null) return;
  const byTrace: ByTrace<Settled> = new Map();
  const format = createFormatter();
  const flush = () => {
    const frame: FormattedExchange[] = [];
    byTrace.forEach((held, trace) => {
      if (isSettled(held)) return void frame.push(...held.shown);
      const shown = format([held]);
      frame.push(...shown);
      if (held.end !== undefined) byTrace.set(trace, { end: held.end, shown });
    });
    sink(frame);
  };
  // The one frame pending, by the function that cancels it: scheduled by the first event after a frame, none once it
  // has run.
  let frame: (() => void) | undefined;
  const shownAtFrame = () => {
    frame = undefined;
    settle();
  };
  const ended = new AbortController();
  const reading = AbortSignal.any([signal, ended.signal]);
  reading.addEventListener("abort", () => frame?.());
  // Shows what is pending, and ends the read in `outcome` if it has one, or in the failure of showing it.
  const settle = (outcome?: Reading) => {
    let result = outcome;
    try {
      flush();
    } catch (error) {
      result = { state: "failed", error: asError(error) };
    }
    if (result === undefined) return;
    ended.abort();
    changed(result);
  };
  connection.read(
    open,
    {
      event: (event, offset) => {
        const placed = add(byTrace, event);
        if (typeof placed === "string") return settle({ state: "failed", error: new Error(open, { cause: refusedAt(offset, placed) }) });
        frame ??= frames(shownAtFrame);
      },
      end: (end) => settle({ state: "ended", name: open, end }),
      failed: (error) => settle({ state: "failed", error }),
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
export function useRecording(connection: Connection, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>(() => begun(open));
  const read = useExchanges((store) => store.read);
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, open, recording.show, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, open, read]);
  return reading;
}
