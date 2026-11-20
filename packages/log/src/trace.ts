// [LAW:one-source-of-truth] [LAW:single-enforcer] The one shape a trace id has, minted and parsed here alone. An
// exchange's trace id is the first segment of every row key the UI builds for it and the namespace of its thread items
// (`<trace>/<group>`, `thread:<trace>/...`), so it is a word: one or more letters, digits, '-' or '_', holding none of
// the separators a key is cut at. Imports nothing that needs node, so the UI's parse uses it too.

declare const minted: unique symbol;
export type TraceId = string & { readonly [minted]: true };

// What a refusal says a trace id must be.
export const traceIdShape = "a trace id (one or more letters, digits, '-' or '_')";

export const isTraceId = (value: unknown): value is TraceId => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

export function parseTraceId(value: unknown): TraceId {
  if (!isTraceId(value)) throw new Error(`${JSON.stringify(value)} is not ${traceIdShape}`);
  return value;
}

// A new trace's id, W3C Trace Context's: 16 random bytes as lowercase hex.
export function mintTraceId(): TraceId {
  return parseTraceId(Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}
