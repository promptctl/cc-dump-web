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

// One exchange of a recording: its two sides, its end, which is undefined until the exchange ends, and its latest
// event. A recording only grows, so two derivations of an exchange with the same latest event hold the same events.
export type Exchange = { trace_id: string; request: RequestSide; response: ResponseSide; end: Of<"end"> | undefined; latest: RecordedEvent };

// The last event that changed a side, so two derivations of a side with the same latest event are the same side.
export function latest(side: RequestSide | ResponseSide): RecordedEvent | undefined {
  return side.completedBy ?? side.body.at(-1) ?? side.head;
}

// The exchanges of `events`, in the order they began.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace = new Map<string, Exchange>();
  for (const event of events) {
    const exchange = byTrace.get(event.trace_id) ?? {
      trace_id: event.trace_id,
      request: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
      response: { head: undefined, body: [], trailers: undefined, completedBy: undefined },
      end: undefined,
      latest: event,
    };
    exchange.latest = event;
    byTrace.set(event.trace_id, exchange);
    switch (event.type) {
      case "request":
        exchange.request.head = event;
        break;
      case "request_body":
        exchange.request.body.push(event);
        break;
      case "request_trailers":
        exchange.request.trailers = event;
        exchange.request.completedBy = event;
        break;
      case "response":
        exchange.response.head = event;
        break;
      case "response_body":
        exchange.response.body.push(event);
        break;
      case "response_trailers":
        exchange.response.trailers = event;
        exchange.response.completedBy = event;
        break;
      case "end":
        exchange.end = event;
        for (const side of [exchange.request, exchange.response]) side.completedBy ??= latest(side) === undefined ? undefined : event;
        break;
    }
  }
  return [...byTrace.values()];
}
