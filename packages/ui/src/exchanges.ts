import type { TraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";

export type Of<T extends RecordedEvent["type"]> = Extract<RecordedEvent, { type: T }>;

// One side of an exchange, the request or the response, as recorded: its head, its body's chunks in order, and its
// trailers, which the proxy records when the body is complete (none if it had none). Each is recorded by its own write,
// so each may be missing alone: not yet, for an exchange in flight; never, for one whose write failed, since the
// recorder counts a failed write and goes on writing the exchange's later events.
// `completedBy`: the event after which no more of it will be recorded, its trailers, or, when it began and they were
// never recorded (it was cut short, or their write failed), its exchange's end.
export type Side<Head, Body, Trailers> = { head: Head | undefined; body: Body[]; trailers: Trailers | undefined; completedBy: Trailers | Of<"end"> | undefined };
export type RequestSide = Side<Of<"request">, Of<"request_body">, Of<"request_trailers">>;
export type ResponseSide = Side<Of<"response">, Of<"response_body">, Of<"response_trailers">>;

// One exchange of a recording: its two sides, its end, which is undefined until the exchange ends, and its first and
// latest events. A recording only grows, so two derivations of an exchange with the same latest event hold the same
// events.
export type Exchange = { trace_id: TraceId; request: RequestSide; response: ResponseSide; end: Of<"end"> | undefined; first: RecordedEvent; latest: RecordedEvent };

// The last event that changed a side, so two derivations of a side with the same latest event are the same side.
export function latest(side: RequestSide | ResponseSide): RecordedEvent | undefined {
  return side.completedBy ?? side.body.at(-1) ?? side.head;
}

// The read's exchanges, by trace, in the order they began.
export type ByTrace = Map<TraceId, Exchange>;

// [LAW:single-enforcer] [LAW:parse-dont-validate] The one step that places an event in its exchange, and the one place
// a recording is held to the shape the proxy writes: a trace holds one request head and one response head, at most one
// trailers per side, and one end; a side takes nothing after its trailers, and a trace nothing after its end. An event
// that breaks it is refused, as what is wrong, and placed nowhere: what `byTrace` holds stays as it was. A head never
// recorded, or a body before its head, is the shape: the recorder writes it when a head's write fails.
export function add(byTrace: ByTrace, event: RecordedEvent): string | undefined {
  const exchange = byTrace.get(event.trace_id) ?? begun(event);
  const place = placing(exchange, event);
  if (typeof place === "string") return place;
  place();
  exchange.latest = event;
  byTrace.set(event.trace_id, exchange);
  return undefined;
}

// The exchanges of `events`, in the order they began, or an error naming the first event that breaks the shape.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace: ByTrace = new Map();
  events.forEach((event, index) => {
    const refused = add(byTrace, event);
    if (refused !== undefined) throw new Error(`event ${index + 1}, trace ${event.trace_id}'s ${event.type}: ${refused}`);
  });
  return [...byTrace.values()];
}

const begun = (event: RecordedEvent): Exchange => ({
  trace_id: event.trace_id,
  request: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
  response: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
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
    default:
      event satisfies never;
      return "is of no type a recording holds";
  }
}

// [LAW:one-type-per-behavior] Both sides take their events by one rule. Each step is typed by its side, so an event of
// one side cannot be placed on the other.
const head = <H, B, T>(side: Side<H, B, T>, event: NoInfer<H>) =>
  closed(side) ?? (side.head === undefined ? () => void (side.head = event) : "is a second head on its side");

const body = <H, B, T>(side: Side<H, B, T>, event: NoInfer<B>) => closed(side) ?? (() => void side.body.push(event));

const trailers = <H, B, T>(side: Side<H, B, T>, event: NoInfer<T>) =>
  closed(side) ??
  (() => {
    side.trailers = event;
    side.completedBy = event;
  });

// Why a side takes nothing more: its trailers are recorded. Undefined while it is open.
const closed = (side: Side<unknown, unknown, unknown>) => (side.trailers === undefined ? undefined : "follows its side's trailers");
