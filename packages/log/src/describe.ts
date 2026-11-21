// An error and its causes, outermost first, in the words a person is shown: a parse failure says which read it ended.
// Its own module, importing nothing, so the UI uses it too.
export function describe(error: unknown): string {
  return error instanceof Error ? [error.message, ...(error.cause === undefined ? [] : [describe(error.cause)])].join(": ") : String(error);
}

// What was thrown, as an Error: itself, or, when it is no Error, a new one that says it in the same words.
export const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(describe(thrown)));
