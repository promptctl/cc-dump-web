import type { TraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";

export type Of<T extends RecordedEvent["type"]> = Extract<RecordedEvent, { type: T }>;

// One side of an exchange, the request or the response, as recorded: its head, its body's chunks in order, until a read
// lets them go (release), and the event that completed it. Each is recorded by its own write, so each may be missing alone: not yet, for an exchange in
// flight; never, for one whose write failed, since the recorder counts a failed write and goes on writing the
// exchange's later events.
// [LAW:one-source-of-truth] `completedBy`: the event after which no more of it will be recorded: its trailers, which the
// proxy records when its body is complete, or, when it began and they were never recorded (it was cut short, or their
// write failed), its exchange's end. Its trailers are `completedBy` when that is trailers (`trailersOf`).
export type Side<Head, Body, Trailers> = { head: Head | undefined; body: Body[]; completedBy: Trailers | Of<"end"> | undefined };
export type RequestSide = Side<Of<"request">, Of<"request_body">, Of<"request_trailers">>;
export type ResponseSide = Side<Of<"response">, Of<"response_body">, Of<"response_trailers">>;

export function trailersOf(side: RequestSide): Of<"request_trailers"> | undefined;
export function trailersOf(side: ResponseSide): Of<"response_trailers"> | undefined;
export function trailersOf(side: RequestSide | ResponseSide) {
  return side.completedBy?.type === "end" ? undefined : side.completedBy;
}

// One exchange of a recording: its two sides, its end, which is undefined until the exchange ends, and its first and
// latest events. A recording only grows, so two derivations of an exchange with the same latest event hold the same
// events.
export type Exchange = { trace_id: TraceId; request: RequestSide; response: ResponseSide; end: Of<"end"> | undefined; first: RecordedEvent; latest: RecordedEvent };

// [LAW:types-are-the-program] An exchange as the conversation shows it: its trace, its heads and its end, and none of
// its bodies, which only the formatter reads (format/format.ts).
export type ExchangeShown = { trace_id: TraceId; request: { head: Of<"request"> | undefined }; response: { head: Of<"response"> | undefined }; end: Of<"end"> | undefined };

// An exchange that has ended, and so takes no more events (add).
export type Ended = Exchange & { end: Of<"end"> };
export const isEnded = (exchange: Exchange): exchange is Ended => exchange.end !== undefined;

// [LAW:one-source-of-truth] What a read lets go of an ended exchange once it is formatted: its bodies' chunks. A trace
// takes nothing after its end, and the formatter reads an ended side from what it made under the side's latest event,
// which the side keeps (latest), never from its chunks again. So a read holds a recording's bodies only while their
// exchanges run.
export function release({ request, response }: Ended): void {
  request.body = [];
  response.body = [];
}

// The last event that changed a side, so two derivations of a side with the same latest event are the same side.
export function latest(side: RequestSide | ResponseSide): RecordedEvent | undefined {
  return side.completedBy ?? side.body.at(-1) ?? side.head;
}

// The read's exchanges, by trace, in the order they began.
export type ByTrace = Map<TraceId, Exchange>;

// [LAW:single-enforcer] [LAW:parse-dont-validate] The one step that places an event in its exchange, and the one place
// a recording is held to the shape the proxy writes: a trace holds one request head and one response head, at most one
// trailers per side, and one end; a side's head comes before the rest of it and its trailers after, and a trace takes
// nothing after its end. It returns the exchange the event is placed in. An event that breaks the shape is refused, as
// what is wrong with it, naming its trace and type, and placed nowhere: what `byTrace` holds stays as it was. A head
// never recorded is the shape: the recorder writes a side's body without it when the head's write fails.
export function add(byTrace: ByTrace, event: RecordedEvent): Exchange | string {
  const exchange = byTrace.get(event.trace_id) ?? begun(event);
  const place = placing(exchange, event);
  if (typeof place === "string") return `trace ${event.trace_id}'s ${event.type} ${place}`;
  place();
  exchange.latest = event;
  byTrace.set(event.trace_id, exchange);
  return exchange;
}

const begun = (event: RecordedEvent): Exchange => ({
  trace_id: event.trace_id,
  request: { head: undefined, body: [], completedBy: undefined },
  response: { head: undefined, body: [], completedBy: undefined },
  end: undefined,
  first: event,
  latest: event,
});

// What `event` does to `exchange`, not yet done, or why it has no place there.
function placing(exchange: Exchange, event: RecordedEvent): string | (() => void) {
  if (exchange.end !== undefined) return "follows its trace's end";
  switch (event.type) {
    case "request":
      return head(exchange.request, event);
    case "request_body":
      return body(exchange.request, event);
    case "request_trailers":
      return trailers(exchange.request, event);
    case "response":
      return head(exchange.response, event);
    case "response_body":
      return body(exchange.response, event);
    case "response_trailers":
      return trailers(exchange.response, event);
    case "end":
      return () => {
        exchange.end = event;
        for (const side of [exchange.request, exchange.response]) side.completedBy ??= latest(side) === undefined ? undefined : event;
      };
  }
}

// [LAW:one-type-per-behavior] Both sides take their events by one rule. Each step is typed by its side, so an event of
// one side cannot be placed on the other.
const head = <H, B, T>(side: Side<H, B, T>, event: NoInfer<H>) =>
  closed(side) ?? (side.head !== undefined ? "is a second head on its side" : side.body.length > 0 ? "follows its side's body" : () => void (side.head = event));

const body = <H, B, T>(side: Side<H, B, T>, event: NoInfer<B>) => closed(side) ?? (() => void side.body.push(event));

const trailers = <H, B, T>(side: Side<H, B, T>, event: NoInfer<T>) => closed(side) ?? (() => void (side.completedBy = event));

// Why a side takes nothing more: it is complete, which before its trace's end is by its trailers. Undefined while it is
// open.
const closed = (side: Side<unknown, unknown, unknown>) => (side.completedBy === undefined ? undefined : "follows its side's trailers");
