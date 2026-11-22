import { kinds, union, value, whole, type Path, type Reader, type Readers, type Tagged, type Variants } from "./json.ts";
import { isErrorStatus, statusText, type ResponseStatus } from "./status.ts";

// [LAW:types-are-the-program] How a unit of work ended. An error is carried exactly when the outcome is
// "error". "aborted" is work its client left; "stopped" is work cut because its server was closed.
// Its own module, importing nothing that needs node, so code that runs without node (the UI) can name it.
export type Ending = { outcome: "ok" | "aborted" | "stopped"; error?: never } | { outcome: "error"; error: string };

// [LAW:types-are-the-program] The fields `C` of a message holding how its work ended, by each outcome: an error's with
// its error. Keyed by every outcome, so an outcome added to `Ending` is a compile error at every use until it is read.
export type Outcomes<C> = { [O in Ending["outcome"]]: O extends "error" ? C & { error: string } : C };

// [LAW:single-enforcer] The readers of a message whose fields `readers` reads, by how its work ended.
export const outcomes = <C>(readers: Readers<C>): Variants<Outcomes<C>> =>
  // the error's readers are `readers` and the error's own, which is what `C & { error: string }` holds
  ({ ok: readers, aborted: readers, stopped: readers, error: { ...readers, error: value(kinds.string) } }) as unknown as Variants<Outcomes<C>>;

// A message holding how its work ended, read whole: its fields and its outcome.
export function ended<C>(read: Tagged<Outcomes<C>>, at: Path): C & Ending {
  // [LAW:types-are-the-program] the outcome named the variant whose fields were read
  return { ...whole(read.fields, at), outcome: read.tag } as C & Ending;
}

// An ending alone: no fields of the message's own.
const endings = union<"outcome", Outcomes<Record<never, never>>>("outcome", outcomes<Record<never, never>>({}));

// [LAW:single-enforcer] How a unit of work ended, as a message holding it says (a log line, a recording's `end`): its
// outcome, and its error, there exactly when the outcome is "error". The message's other fields are its own.
export const ending: Reader<Ending> = (json, at) => {
  const read = endings(json, at);
  return { value: ended(read.value, at), dropped: read.dropped, unread: [] };
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
