import { useEffect, useState } from "react";

// [LAW:types-are-the-program] Where a question to the backend stands: asked, answered, or failed.
export type Answer<T> = { state: "asking" } | { state: "answered"; value: T } | { state: "failed"; error: Error };

// The answer to `ask`, asked as the component using it mounts, which is as what shows it opens, so each opening reads
// afresh. A question still open as it unmounts is aborted, and its abort is that closing, not a failure. To ask again,
// mount it again: under a new key.
export function useAnswer<T>(ask: (signal: AbortSignal) => Promise<T>): Answer<T> {
  const [answer, setAnswer] = useState<Answer<T>>({ state: "asking" });
  useEffect(() => {
    const abort = new AbortController();
    ask(abort.signal).then(
      (value) => setAnswer({ state: "answered", value }),
      (error: Error) => abort.signal.aborted || setAnswer({ state: "failed", error }),
    );
    return () => abort.abort();
  }, [ask]);
  return answer;
}
