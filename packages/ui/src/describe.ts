// An error and its causes, outermost first: a parse failure says which read it ended.
export function describe(error: unknown): string {
  return error instanceof Error ? [error.message, ...(error.cause === undefined ? [] : [describe(error.cause)])].join(": ") : String(error);
}
