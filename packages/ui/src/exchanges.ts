import type { RecordedEvent } from "@cc-dump/proxy/format";

type Of<T extends RecordedEvent["type"]> = Extract<RecordedEvent, { type: T }>;

// One exchange of a recording: its request, response and end, each undefined while the recording does not hold it.
// Not yet, for an exchange in flight; never, for one whose write failed, since the recorder counts a failed write
// and goes on writing the exchange's later events.
export type Exchange = {
  trace_id: string;
  request: Of<"request"> | undefined;
  response: Of<"response"> | undefined;
  end: Of<"end"> | undefined;
};

// The exchanges of `events`, in the order they began.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace = new Map<string, Exchange>();
  for (const event of events) {
    const exchange = byTrace.get(event.trace_id) ?? { trace_id: event.trace_id, request: undefined, response: undefined, end: undefined };
    byTrace.set(event.trace_id, exchange);
    switch (event.type) {
      case "request":
        exchange.request = event;
        break;
      case "response":
        exchange.response = event;
        break;
      case "end":
        exchange.end = event;
        break;
    }
  }
  return [...byTrace.values()];
}
