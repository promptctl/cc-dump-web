import { fields, parseJson } from "./json.ts";

// [LAW:one-source-of-truth] What both ends of a part's HTTP wire agree on: the answer a refused or failed request gets,
// the Server-Sent Events a stream is written and read as, and the one way a client asks. Imports nothing that needs
// node, so the UI uses it too; the writing side of the wire, which does need node, is answer.ts.

// Every refused or failed request's answer: why, in words the user is shown as they are (tmux's own, when tmux refused).
export type Failure = { error: string };

export function parseFailure(json: string): Failure {
  return { error: fields(parseJson(json, "failure"), "failure").string("error") };
}

// A request a part answered with an error status: the status, and the words it said why in, its `Failure`'s or, when
// its body was no `Failure` (a proxy's, node's own refusal of a malformed request), the status line.
export class Answered extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// [LAW:single-enforcer] The one way a client asks a part: its answer to one request, parsed. An answer with an error
// status fails as `Answered`, in the part's own words, which are the user's to read as they are; any other failure, the
// connection's or the parse's, names the request, with the failure its `cause`.
export async function ask<T>(url: string, init: RequestInit, parse: (text: string) => T): Promise<T> {
  let refusal: Answered;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    if (res.ok) return parse(text);
    refusal = new Answered(res.status, failureWords(text) ?? `${res.status} ${res.statusText}`);
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${url}`, { cause: error });
  }
  throw refusal;
}

// The words of a `Failure` body, or none when the body is not one.
function failureWords(body: string): string | undefined {
  try {
    return parseFailure(body).error;
  } catch {
    return undefined;
  }
}

export type ServerSentEvent = { id?: string; event: string; data: string };

// The complete events of a server-sent event stream (each ended by a blank line), and the text after the last.
// Per the WHATWG spec: lines end in CRLF, LF or CR; `data` lines join with LF; a line starting with a colon is a
// comment; one space after a field's colon is dropped; an event with no `event` field, or an empty one, is named
// "message". A CR that ends text not yet `complete` waits in the rest, since the LF of its CRLF may be the next text to
// arrive.
export function serverSentEvents(text: string, complete: boolean): { events: ServerSentEvent[]; rest: string } {
  const waiting = !complete && text.endsWith("\r") ? "\r" : "";
  const chunks = text.slice(0, text.length - waiting.length).replace(/\r\n?/g, "\n").split("\n\n");
  const rest = (chunks.pop() ?? "") + waiting;
  const events = chunks.flatMap((chunk) => {
    let event = "";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "id") id = value;
      if (field === "data") data.push(value);
    }
    // An event with no data line is not dispatched.
    return data.length === 0 ? [] : [{ ...(id === undefined ? {} : { id }), event: event === "" ? "message" : event, data: data.join("\n") }];
  });
  return { events, rest };
}
