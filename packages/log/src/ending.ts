// [LAW:types-are-the-program] How a unit of work ended. An error is carried exactly when the outcome is
// "error". "aborted" is work its client left; "stopped" is work cut because its server was closed.
// Its own module, importing nothing, so code that runs without node (the UI) can name it.
export type Ending = { outcome: "ok" | "aborted" | "stopped"; error?: never } | { outcome: "error"; error: string };
