// [LAW:one-source-of-truth] The one shape of a trace id, minted and parsed here: W3C Trace Context's 16 random bytes as
// lowercase hex. A row key and a thread's namespace begin with an exchange's trace id and are cut at '/', so an id of
// any other shape would place what it names under another exchange. Imports nothing that needs node, so the UI's
// parsers take it too.

declare const traceIdShape: unique symbol;
export type TraceId = string & { readonly [traceIdShape]: true };

export const isTraceId = (value: unknown): value is TraceId => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export function mintTraceId(): TraceId {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return id as TraceId;
}
