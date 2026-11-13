import type { RecordedEvent } from "@cc-dump/proxy/format";

export type Of<T extends RecordedEvent["type"]> = Extract<RecordedEvent, { type: T }>;

// One side of an exchange, the request or the response, as recorded: its head, its body's chunks in order, and its
// trailers, which the proxy records when the body is complete (none if it had none). Each is recorded by its own write,
// so each may be missing alone: not yet, for an exchange in flight; never, for one whose write failed, since the
// recorder counts a failed write and goes on writing the exchange's later events.
// `complete`: its body is whole, since its trailers are recorded, or it began and its exchange has ended. `latest`: the
// last event that changed it, the end that completed it among them, so two derivations of a side with the same latest
// event are the same side.
export type Side<Head, Body, Trailers> = { head: Head | undefined; body: Body[]; trailers: Trailers | undefined; complete: boolean; latest: RecordedEvent | undefined };
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
      request: { head: undefined, body: [], trailers: undefined, complete: false, latest: undefined },
      response: { head: undefined, body: [], trailers: undefined, complete: false, latest: undefined },
      end: undefined,
      latest: event,
    };
    exchange.latest = event;
    byTrace.set(event.trace_id, exchange);
    switch (event.type) {
      case "request":
        exchange.request.head = event;
        exchange.request.latest = event;
        break;
      case "request_body":
        exchange.request.body.push(event);
        exchange.request.latest = event;
        break;
      case "request_trailers":
        exchange.request.trailers = event;
        exchange.request.complete = true;
        exchange.request.latest = event;
        break;
      case "response":
        exchange.response.head = event;
        exchange.response.latest = event;
        break;
      case "response_body":
        exchange.response.body.push(event);
        exchange.response.latest = event;
        break;
      case "response_trailers":
        exchange.response.trailers = event;
        exchange.response.complete = true;
        exchange.response.latest = event;
        break;
      case "end":
        exchange.end = event;
        ended(exchange.request, event);
        ended(exchange.response, event);
        break;
    }
  }
  return [...byTrace.values()];
}

// The end completes a side that began and whose trailers were never recorded: it was cut short, or their write failed.
// A side that never began has no body to complete; one already complete is left as it was.
function ended(side: { complete: boolean; latest: RecordedEvent | undefined }, end: Of<"end">) {
  if (side.complete || side.latest === undefined) return;
  side.complete = true;
  side.latest = end;
}
