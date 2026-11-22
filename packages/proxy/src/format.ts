import { outcomes, type Ending } from "@cc-dump/log/ending";
import { fields as jsonFields, parseJson } from "@cc-dump/log/json";
import { parseTraceId, type TraceId } from "@cc-dump/log/trace";

// [LAW:one-source-of-truth] What the proxy's readers receive: the recording format, and the reader's own
// messages. Imports nothing that needs node, so the UI and any other reader take these types, and their
// parsers, from here.

export type Header = [name: string, value: string];

// The recording format: one JSON line per event, in the order the proxy saw them, joined into exchanges by the
// trace_id of the request's log event; overlapping exchanges interleave.
// [LAW:decomposition] It holds the wire, not an interpretation of it: headers in arrival order, case and
// repetition, trailers too; body chunks as the bytes received, base64 (a gzip body stays gzip), so later parsing
// applies to old recordings too. A message's trailers are recorded when its body is complete, none if it had
// none, so a body cut short has no trailers event. An exchange ends as its relayed response did (`Work.ended`): one
// relayed in full is ok whatever its status, which `response` records, though its request's log event says it failed.
export type Recorded =
  | { type: "request"; method: string; url: string; http_version: string; headers: Header[] }
  | { type: "request_body"; base64: string }
  | { type: "request_trailers"; headers: Header[] }
  | { type: "response"; status: number; reason: string; http_version: string; headers: Header[] }
  | { type: "response_body"; base64: string }
  | { type: "response_trailers"; headers: Header[] }
  | ({ type: "end" } & Ending);
export type RecordedEvent = { timestamp: string; trace_id: TraceId } & Recorded;

// One recording in `GET /recordings`: a `.jsonl` file in the recordings directory. `POST /recordings` answers the one it
// created.
export type Listing = { name: string };

// [LAW:one-source-of-truth] The names of recordings, the writer's formats and their reader, side by side. A recording is
// one Claude Code process's (docs/design/01-features.md, Vocabulary), named for the moment the app launched it, in ISO 8601
// basic format (no colons, which Finder and Windows refuse). Traffic that names no process goes to the proxy run's
// recording, named for the moment the run started, so the two kinds are told apart by the name alone.
const basicStart = (start: Date) => start.toISOString().replace(/[-:]/g, "");

export function recordingName(start: Date): string {
  return `${basicStart(start)}.jsonl`;
}

export function runRecordingName(start: Date): string {
  return `run-${basicStart(start)}.jsonl`;
}

export type RecordingKind = "agent" | "run";

// The kind and the start a name was made from, or undefined for a name no part of the app made: the recordings
// directory is the user's too, and every `.jsonl` file in it is listed.
export function parseRecordingName(name: string): { kind: RecordingKind; start: Date } | undefined {
  const basic = /^(run-)?(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}\.\d{3})Z\.jsonl$/.exec(name);
  if (!basic) return undefined;
  const [, run, year, month, day, hours, minutes, seconds] = basic;
  const start = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`);
  const kind = run ? "run" : "agent";
  return !Number.isNaN(start.getTime()) && (kind === "run" ? runRecordingName(start) : recordingName(start)) === name ? { kind, start } : undefined;
}

// The start of an agent's recording, or undefined for any other name.
export function recordingStart(name: string): Date | undefined {
  const parsed = parseRecordingName(name);
  return parsed?.kind === "agent" ? parsed.start : undefined;
}

// An agent's way to its recording is the base URL it is launched with: the proxy's, then the recording's name without
// its `.jsonl`. Claude Code keeps that path on every request it makes, so the proxy tells whose a request is from its
// URL. No header names a process: one process's requests carry several session IDs.
const agentPath = "/agent/";
export function agentBaseUrl(baseUrl: string, name: string): string {
  return `${baseUrl}${agentPath}${name.slice(0, -".jsonl".length)}`;
}

// The agent's path, its stem, and what follows the stem: the rest of the URL's path, a query, or nothing, which is a
// request to the base URL itself.
const agentUrl = new RegExp(`^${agentPath}([^/?#]+)(/.*|\\?.*)?$`);

// The recording an agent's request belongs to, and its URL without the path the proxy gave the agent, which is the URL
// as the upstream knows it: a request to the base URL itself is the upstream's `/`, with its query. Undefined for a
// request that is no agent's: one naming none, or a stem that is not a recording's name, which is the proxy run's own.
export function agentOf(url: string): { name: string; url: string } | undefined {
  const [, stem, rest = ""] = agentUrl.exec(url) ?? [];
  const name = `${stem}.jsonl`;
  return stem !== undefined && recordingStart(name) !== undefined ? { name, url: rest.startsWith("/") ? rest : `/${rest}` } : undefined;
}

// A byte offset in a recording, as a read's event ids and positions write it: a decimal integer a file can have, or
// undefined for any other text.
export function offsetOf(text: string): number | undefined {
  const offset = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(offset) ? offset : undefined;
}

// The data of a finished recording's `end` event: the bytes after its last newline, which a write cut short left.
export type RecordingEnd = { unterminated_bytes: number };

// The data of a read's `failed` event, sent when the reader fails after the read began: the error's message.
// The whole error, stack and all, is the request's log event's.
export type ReadFailure = { message: string };

// Each message of `GET /status`: the proxy's state now, whole (docs/design/01-features.md, F8, F12): what it is, so a reader
// following it across a restart knows the restarted proxy, whether it runs its source on disk, and its traffic.
export type ProxyStatus = { info: ProxyInfo; source: SourceStatus; traffic: Traffic };

// Whether the proxy runs the source on disk. `changed_source`: the files whose text on disk differs from the text the
// proxy runs, or that are gone; a restart of the proxy is pending while there is one. A watch that failed says so, and
// is never an empty `changed_source`: a dead watch must not read as nothing pending.
export type SourceStatus = { state: "watching"; changed_source: string[] } | { state: "failed"; message: string };

// The agents' requests this run of the proxy forwards. `in_flight`: those that arrived and have not ended.
// `last_request`: when the latest arrived, as an ISO time; null until the run's first.
export type Traffic = { in_flight: number; last_request: string | null };

// `GET /info`, and each status: what the running proxy is, for as long as it runs. `base_url`: the address agents are pointed at, the
// `ANTHROPIC_BASE_URL` they are given, on the port the proxy bound. `upstream`: where it forwards what they send.
// `recordings`: the directory its recordings are in, each the file there its name names.
export type ProxyInfo = { base_url: string; upstream: string; recordings: string };

// [LAW:parse-dont-validate] [LAW:single-enforcer] The one checkpoint each message of these types crosses on its way to a
// reader.
// Recordings outlive edits to these types, and the proxy keeps running while its readers reload, so a message of
// another shape is refused here, naming what does not fit, instead of travelling on as a field that is not there.

export function parseListings(json: string): Listing[] {
  const listings = parseJson(json, "recordings list");
  if (!Array.isArray(listings)) throw new Error("recordings list: is not an array");
  return listings.map((listing: unknown) => listingOf(listing, "recordings list entry"));
}

export function parseListing(json: string): Listing {
  return listingOf(parseJson(json, "recording"), "recording");
}

const listingOf = (listing: unknown, what: string): Listing => ({ name: fields(listing, what).string("name") });

export function parseRecordingEnd(json: string): RecordingEnd {
  return { unterminated_bytes: fields(parseJson(json, "recording end"), "recording end").integer("unterminated_bytes") };
}

export function parseReadFailure(json: string): ReadFailure {
  return { message: fields(parseJson(json, "read failure"), "read failure").string("message") };
}

export function parseProxyStatus(json: string): ProxyStatus {
  const status = fields(parseJson(json, "proxy status"), "proxy status");
  const source = fields(status.object("source"), "proxy status: source");
  const traffic = fields(status.object("traffic"), "proxy status: traffic");
  const state = source.oneOf("state", sourceStates);
  return {
    info: infoOf(status.object("info"), "proxy status: info"),
    source: state === "watching" ? { state, changed_source: source.strings("changed_source") } : { state, message: source.string("message") },
    traffic: { in_flight: traffic.integer("in_flight"), last_request: traffic.read("last_request", isTimeOrNull, `${aTime} or null`) },
  };
}

export function parseProxyInfo(json: string): ProxyInfo {
  return infoOf(parseJson(json, "proxy info"), "proxy info");
}

function infoOf(info: unknown, what: string): ProxyInfo {
  const f = fields(info, what);
  return { base_url: f.string("base_url"), upstream: f.string("upstream"), recordings: f.string("recordings") };
}

export function parseRecordedEvent(line: string): RecordedEvent {
  const json = parseJson(line, "recorded event");
  const type = fields(json, "recorded event").oneOf("type", recordedTypes);
  const trace_id = fields(json, `recorded ${type} event`).parsed("trace_id", parseTraceId);
  // Named as the fold names an event it refuses (ui/src/exchanges.ts), so either refusal names its trace and type.
  const f = fields(json, `trace ${trace_id}'s ${type}`);
  const event = { timestamp: f.read("timestamp", isTime, aTime), trace_id };
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
const sourceStates: Record<SourceStatus["state"], true> = { watching: true, failed: true };
// A time exactly as `toISOString` writes it, which is how the proxy writes every time it records or sends.
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const aTime = "an ISO 8601 UTC time";
const isTimeOrNull = (value: unknown): value is string | null => value === null || isTime(value);

// The fields of `what`, with the recording format's headers beside the JSON types.
function fields(json: unknown, what: string) {
  const f = jsonFields(json, what);
  return { ...f, headers: (name: string) => f.read(name, isHeaders, "a list of [name, value] string pairs") };
}

const isHeaders = (value: unknown): value is Header[] =>
  Array.isArray(value) && value.every((header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === "string"));
