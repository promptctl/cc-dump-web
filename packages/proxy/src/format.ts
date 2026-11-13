import type { Ending } from "@cc-dump/log/ending";

// [LAW:one-source-of-truth] What the proxy's readers receive: the recording format, and the reader's own
// messages. Imports nothing that needs node, so the UI and any other reader take these types, and their
// parsers, from here.

export type Header = [name: string, value: string];

// The recording format: one JSON line per event, in the order the proxy saw them, joined into exchanges by the
// trace_id of the request's log event; overlapping exchanges interleave.
// [LAW:decomposition] It holds the wire, not an interpretation of it: headers in arrival order, case and
// repetition, trailers too; body chunks as the bytes received, base64 (a gzip body stays gzip), so later parsing
// applies to old recordings too. A message's trailers are recorded when its body is complete, none if it had
// none, so a body cut short has no trailers event. An exchange ends with the ending its log event records.
export type Recorded =
  | { type: "request"; method: string; url: string; http_version: string; headers: Header[] }
  | { type: "request_body"; base64: string }
  | { type: "request_trailers"; headers: Header[] }
  | { type: "response"; status: number; reason: string; http_version: string; headers: Header[] }
  | { type: "response_body"; base64: string }
  | { type: "response_trailers"; headers: Header[] }
  | ({ type: "end" } & Ending);
export type RecordedEvent = { timestamp: string; trace_id: string } & Recorded;

// One recording in `GET /recordings`: the live one is the run's, still being written.
export type Listing = { name: string; live: boolean };

// The data of a finished recording's `end` event: the bytes after its last newline, which a write cut short left.
export type RecordingEnd = { unterminated_bytes: number };

// The data of a read's `failed` event, sent when the reader fails after the read began: the error's message.
// The whole error, stack and all, is the request's log event's.
export type ReadFailure = { message: string };

// [LAW:parse-dont-validate] [LAW:single-enforcer] The one checkpoint each message crosses on its way to a reader.
// Recordings outlive edits to these types, and the proxy keeps running while its readers reload, so a message of
// another shape is refused here, naming what does not fit, instead of travelling on as a field that is not there.

export function parseListings(json: string): Listing[] {
  const listings = parseJson(json, "recordings list");
  if (!Array.isArray(listings)) throw new Error("recordings list: is not an array");
  return listings.map((listing: unknown) => {
    const f = fields(listing, "recordings list entry");
    return { name: f.string("name"), live: f.boolean("live") };
  });
}

export function parseRecordingEnd(json: string): RecordingEnd {
  return { unterminated_bytes: fields(parseJson(json, "recording end"), "recording end").integer("unterminated_bytes") };
}

export function parseReadFailure(json: string): ReadFailure {
  return { message: fields(parseJson(json, "read failure"), "read failure").string("message") };
}

export function parseRecordedEvent(line: string): RecordedEvent {
  const json = parseJson(line, "recorded event");
  const type = fields(json, "recorded event").oneOf("type", recordedTypes);
  const f = fields(json, `recorded ${type} event`);
  const event = { timestamp: f.string("timestamp"), trace_id: f.string("trace_id") };
  switch (type) {
    case "request":
      return { ...event, type, method: f.string("method"), url: f.string("url"), http_version: f.string("http_version"), headers: f.headers("headers") };
    case "request_body":
    case "response_body":
      return { ...event, type, base64: f.string("base64") };
    case "request_trailers":
    case "response_trailers":
      return { ...event, type, headers: f.headers("headers") };
    case "response":
      return { ...event, type, status: f.integer("status"), reason: f.string("reason"), http_version: f.string("http_version"), headers: f.headers("headers") };
    case "end": {
      const outcome = f.oneOf("outcome", outcomes);
      return outcome === "error" ? { ...event, type, outcome, error: f.string("error") } : { ...event, type, outcome };
    }
  }
}

// Keyed by the unions they list, so a type or an outcome added to the format is a compile error here until
// the parse knows it.
const recordedTypes: Record<Recorded["type"], true> = {
  request: true,
  request_body: true,
  request_trailers: true,
  response: true,
  response_body: true,
  response_trailers: true,
  end: true,
};
const outcomes: Record<Ending["outcome"], true> = { ok: true, aborted: true, stopped: true, error: true };

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what}: is not JSON`, { cause: error });
  }
}

// The fields of `what`, a JSON object, each read as the JSON type it must have, or an error naming it.
function fields(json: unknown, what: string) {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${what}: is not an object`);
  const object = json as Record<string, unknown>;
  const read = <T>(name: string, fits: (value: unknown) => value is T, expected: string): T => {
    const value = object[name];
    if (!fits(value)) throw new Error(`${what}: ${name} is not ${expected}`);
    return value;
  };
  return {
    string: (name: string) => read(name, (value) => typeof value === "string", "a string"),
    boolean: (name: string) => read(name, (value) => typeof value === "boolean", "a boolean"),
    integer: (name: string) => read(name, Number.isSafeInteger as (value: unknown) => value is number, "an integer"),
    oneOf: <T extends string>(name: string, values: Record<T, true>) =>
      read(name, (value): value is T => typeof value === "string" && Object.hasOwn(values, value), `one of ${Object.keys(values).join(", ")}`),
    headers: (name: string) => read(name, isHeaders, "a list of [name, value] string pairs"),
  };
}

const isHeaders = (value: unknown): value is Header[] =>
  Array.isArray(value) && value.every((header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === "string"));
