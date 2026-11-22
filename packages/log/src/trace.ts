// [LAW:parse-dont-validate] A trace id: what joins a unit of work's events, and a recording's events into an exchange.
// A word, so the UI can begin a row key with it and join the key's parts with any separator a word never holds ('/',
// ':', '.', ' '). Imports nothing that needs node, so the UI takes it from here.
import { Malformed } from "./failure.ts";

declare const traceId: unique symbol;
export type TraceId = string & { readonly [traceId]: true };

const isTraceId = (value: unknown): value is TraceId => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

export function parseTraceId(value: unknown): TraceId {
  if (!isTraceId(value)) throw new Malformed(`${JSON.stringify(value)} is not a word: one or more letters, digits, '-' or '_'`);
  return value;
}

// A new trace's id, W3C Trace Context's: 16 random bytes as lowercase hex.
export function mintTraceId(): TraceId {
  return parseTraceId(randomHex(16));
}

// `bytes` random bytes as lowercase hex, the encoding of every id the parts mint.
export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
