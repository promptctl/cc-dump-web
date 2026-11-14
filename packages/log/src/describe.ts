// An error and its causes, outermost first, in the words a person is shown: a parse failure says which read it ended.
// Its own module, importing nothing, so the UI uses it too.
export function describe(error: unknown): string {
  return error instanceof Error ? [error.message, ...(error.cause === undefined ? [] : [describe(error.cause)])].join(": ") : String(error);
}
