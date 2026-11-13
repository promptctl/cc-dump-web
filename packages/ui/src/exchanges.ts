import type { RecordedEvent } from "@cc-dump/proxy/format";

export type Of<T extends RecordedEvent["type"]> = Extract<RecordedEvent, { type: T }>;

// One side of an exchange, the request or the response, as recorded: its head, its body's chunks in order, and its
// trailers, which the proxy records when the body is complete (none if it had none). Each is recorded by its own write,
// so each may be missing alone: not yet, for an exchange in flight; never, for one whose write failed, since the
// recorder counts a failed write and goes on writing the exchange's later events.
export type Side<Head, Body, Trailers> = { head: Head | undefined; body: Body[]; trailers: Trailers | undefined };
export type RequestSide = Side<Of<"request">, Of<"request_body">, Of<"request_trailers">>;
export type ResponseSide = Side<Of<"response">, Of<"response_body">, Of<"response_trailers">>;

// One exchange of a recording: its two sides, its end, which is undefined until the exchange ends, and its latest
// event. A recording only grows, so two derivations of an exchange with the same latest event hold the same events.
export type Exchange = { trace_id: string; request: RequestSide; response: ResponseSide; end: Of<"end"> | undefined; latest: RecordedEvent };

// The exchanges of `events`, in the order they began.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace = new Map<string, Exchange>();
  for (const event of events) {
    const exchange = byTrace.get(event.trace_id) ?? {
      trace_id: event.trace_id,
      request: { head: undefined, body: [], trailers: undefined },
      response: { head: undefined, body: [], trailers: undefined },
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
        break;
      case "response":
        exchange.response.head = event;
        break;
      case "response_body":
        exchange.response.body.push(event);
        break;
      case "response_trailers":
        exchange.response.trailers = event;
        break;
      case "end":
        exchange.end = event;
        break;
    }
  }
  return [...byTrace.values()];
}
