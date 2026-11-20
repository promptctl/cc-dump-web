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

// The exchanges of `events`, in the order they began.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace: Exchanges = new Map();
  for (const event of events) add(byTrace, event);
  return [...byTrace.values()];
}

// The exchanges read so far, by trace, in the order they began.
export type Exchanges = Map<TraceId, Exchange>;

// [LAW:single-enforcer] The one step that puts an event in its exchange, so the one place a trace's shape is kept: the
// proxy writes a trace's request head, response head, each side's trailers and its end once each, the end last, and an
// event that would be a second of any, or come after the end, is refused here, with the exchange left as it was.
export function add(byTrace: Exchanges, event: RecordedEvent) {
  const exchange = byTrace.get(event.trace_id) ?? {
    trace_id: event.trace_id,
    request: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
    response: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
    end: undefined,
    first: event,
    latest: event,
  };
  const refused = (what: string) => new Error(`recorded ${event.type} event: trace ${event.trace_id} ${what}`);
  if (exchange.end !== undefined) throw refused("has ended");
  const once = <T>(filled: T | undefined, value: T): T => {
    if (filled !== undefined) throw refused(`already has its ${event.type}`);
    return value;
  };
  switch (event.type) {
    case "request":
      exchange.request.head = once(exchange.request.head, event);
      break;
    case "request_body":
      exchange.request.body.push(event);
      break;
    case "request_trailers":
      exchange.request.trailers = exchange.request.completedBy = once(exchange.request.trailers, event);
      break;
    case "response":
      exchange.response.head = once(exchange.response.head, event);
      break;
    case "response_body":
      exchange.response.body.push(event);
      break;
    case "response_trailers":
      exchange.response.trailers = exchange.response.completedBy = once(exchange.response.trailers, event);
      break;
    case "end":
      exchange.end = event;
      for (const side of [exchange.request, exchange.response]) side.completedBy ??= latest(side) === undefined ? undefined : event;
      break;
  }
  exchange.latest = event;
  byTrace.set(event.trace_id, exchange);
}
