import { kinds, object, value, type Reader } from "./json.ts";
import { isErrorStatus, statusText, type ResponseStatus } from "./status.ts";

// [LAW:types-are-the-program] How a unit of work ended. An error is carried exactly when the outcome is
// "error". "aborted" is work its client left; "stopped" is work cut because its server was closed.
// Its own module, importing nothing that needs node, so code that runs without node (the UI) can name it.
export type Ending = { outcome: "ok" | "aborted" | "stopped"; error?: never } | { outcome: "error"; error: string };

// Every outcome, keyed by the union, so an outcome added to `Ending` is a compile error here until it is read.
const outcomes: Record<Ending["outcome"], true> = { ok: true, aborted: true, stopped: true, error: true };
const outcome = object({ outcome: value(kinds.among(Object.keys(outcomes) as Ending["outcome"][])) });
const error = object({ error: value(kinds.string) });

// [LAW:single-enforcer] How a unit of work ended, as a message holding it says (a log line, a recording's `end`): its
// outcome, and its error, there exactly when the outcome is "error". The message's other fields are its own.
export const ending: Reader<Ending> = (json, at) => {
  const ended = outcome(json, at).value;
  return { value: ended.outcome === "error" ? { outcome: ended.outcome, error: error(json, at).value.error } : { outcome: ended.outcome }, dropped: [], unread: [] };
};

// [LAW:single-enforcer] How a request ended, from how its response ended and the status line it was sent with, which a
// recording holds none of for a response failed before its head, or whose head's write failed (proxy/src/format.ts),
// and so has no status to judge by. A response sent in full with an error status failed its request, by
// that status line, whoever wrote it, a part or an upstream a part relays; every other ending stands, so a failure
// reported is the request's and a cut response was aborted or stopped whatever its status. The proxy's log event of a
// request and the turn strip's mark of its exchange both say this.
export function requestEnding(response: Ending, head: ResponseStatus | undefined): Ending {
  return response.outcome === "ok" && head !== undefined && isErrorStatus(head.status) ? { outcome: "error", error: statusText(head) } : response;
}
