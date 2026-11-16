import { useEffect, useState } from "react";

// [LAW:types-are-the-program] Where a question to the backend stands: asked, answered, or failed.
export type Answer<T> = { state: "asking" } | { state: "answered"; value: T } | { state: "failed"; error: Error };

// The answer to `ask`, asked as the component using it mounts, which is as what shows it opens, so each opening reads
// afresh, and asked again whenever `ask` changes. A question still open as it unmounts, or as another replaces it, is
// aborted, and its abort is that closing, not a failure.
// [LAW:one-source-of-truth] An answer is kept with the question it answers, so a new question is "asking" until its own
// answer comes, never the last one's.
export function useAnswer<T>(ask: (signal: AbortSignal) => Promise<T>): Answer<T> {
  const [answered, setAnswered] = useState<{ ask: typeof ask; answer: Answer<T> } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    // A question closed keeps no answer: one that came after another question replaced it would hide the new one's.
    const keep = (answer: Answer<T>) => abort.signal.aborted || setAnswered({ ask, answer });
    ask(abort.signal).then(
      (value) => keep({ state: "answered", value }),
      (error: Error) => keep({ state: "failed", error }),
    );
    return () => abort.abort();
  }, [ask]);
  return answered?.ask === ask ? answered.answer : { state: "asking" };
}
