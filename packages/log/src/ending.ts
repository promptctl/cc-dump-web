// [LAW:types-are-the-program] How a unit of work ended. An error is carried exactly when the outcome is
// "error". "aborted" is work its client left; "stopped" is work cut because its server was closed.
// Its own module, importing nothing, so code that runs without node (the UI) can name it.
export type Ending = { outcome: "ok" | "aborted" | "stopped"; error?: never } | { outcome: "error"; error: string };

// Every outcome, for a parser to read one by.
export const outcomes: Record<Ending["outcome"], true> = { ok: true, aborted: true, stopped: true, error: true };

// [LAW:single-enforcer] RFC 9110's client error (4xx) and server error (5xx) classes: a status that says its request failed.
export const isErrorStatus = (status: number): boolean => status >= 400;
