import { kinds, tagged, value, type Reader, type Readers } from "./json.ts";
import { isErrorStatus, statusText, type ResponseStatus } from "./status.ts";

// [LAW:types-are-the-program] How a unit of work ended. An error is carried exactly when the outcome is
// "error". "aborted" is work its client left; "stopped" is work cut because its server was closed.
// Its own module, importing nothing that needs node, so code that runs without node (the UI) can name it.
export type Ending = { outcome: "ok" | "aborted" | "stopped"; error?: never } | { outcome: "error"; error: string };

// `Ending`, one variant per outcome, as a message says it.
export type Ended = { outcome: "ok" } | { outcome: "aborted" } | { outcome: "stopped" } | { outcome: "error"; error: string };

// [LAW:one-source-of-truth] The fields each outcome carries, keyed by outcome, so an outcome added to `Ending` is a
// compile error here until it is read. A message holding an ending beside fields of its own (a log line) reads its
// own fields in each variant.
export const endings: { [O in Ended["outcome"]]: Readers<Omit<Extract<Ended, { outcome: O }>, "outcome">> } = { ok: {}, aborted: {}, stopped: {}, error: { error: value(kinds.string) } };

// [LAW:single-enforcer] How a unit of work ended, as a message holding it says (a recording's `end`): its outcome,
// and its error, there exactly when the outcome is "error".
export const ending: Reader<Ending> = tagged<"outcome", Ended>("outcome", endings);

// [LAW:single-enforcer] How a request ended, from how its response ended and the status line it was sent with, which a
// recording holds none of for a response failed before its head, or whose head's write failed (proxy/src/format.ts),
// and so has no status to judge by. A response sent in full with an error status failed its request, by
// that status line, whoever wrote it, a part or an upstream a part relays; every other ending stands, so a failure
// reported is the request's and a cut response was aborted or stopped whatever its status. The proxy's log event of a
// request and the turn strip's mark of its exchange both say this.
export function requestEnding(response: Ending, head: ResponseStatus | undefined): Ending {
  return response.outcome === "ok" && head !== undefined && isErrorStatus(head.status) ? { outcome: "error", error: statusText(head) } : response;
}
