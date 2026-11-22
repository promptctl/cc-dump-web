import { kinds, tagged, value, type Kept, type Reader } from "./json.ts";
import { isErrorStatus, statusText, type ResponseStatus } from "./status.ts";

// [LAW:types-are-the-program] How a unit of work ended, as its outcome says: an error is carried exactly when the
// outcome is "error", and no other outcome may carry one. "aborted" is work its client left; "stopped" is work cut
// because its server was closed. Its own module, importing nothing that needs node, so code that runs without node (the
// UI) can name it.
type Outcome = { outcome: "ok" } | { outcome: "aborted" } | { outcome: "stopped" } | { outcome: "error"; error: string };
type CarryingNoError<O> = O extends { error: string } ? O : O & { error?: never };
export type Ending = CarryingNoError<Outcome>;

// [LAW:single-enforcer] How a unit of work ended, as a message holding it says (a log line, a recording's `end`), beside
// the message's other fields, which are its own. Keyed by the outcomes, so one added is a compile error here until it is
// read.
export const ending: Reader<Kept<Ending>> = tagged<"outcome", Outcome>("outcome", {
  ok: {},
  aborted: {},
  stopped: {},
  error: { error: value(kinds.string) },
});

// [LAW:single-enforcer] How a request ended, from how its response ended and the status line it was sent with, which a
// recording holds none of for a response failed before its head, or whose head's write failed (proxy/src/format.ts),
// and so has no status to judge by. A response sent in full with an error status failed its request, by
// that status line, whoever wrote it, a part or an upstream a part relays; every other ending stands, so a failure
// reported is the request's and a cut response was aborted or stopped whatever its status. The proxy's log event of a
// request and the turn strip's mark of its exchange both say this.
export function requestEnding(response: Ending, head: ResponseStatus | undefined): Ending {
  return response.outcome === "ok" && head !== undefined && isErrorStatus(head.status) ? { outcome: "error", error: statusText(head) } : response;
}
