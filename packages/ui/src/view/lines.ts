// The step each request follows in its thread (docs/design/02-design.md, "Two axes"). A thread's requests are not one
// line: a side question, a compaction, a probe or a rewind resends part of the thread and goes its own way. So each
// request stands after one of the requests before it, and the requests standing after one are siblings, of which the
// column lists one.

// Where a request leaves the requests of its thread before it: after the whole of `step`'s, its reply included
// (`whole`), or inside what `step` added, and at which of the messages it sends it first differs, `message`, the
// reply's index for one that differs in none. None for a thread's first request. `messages`: how many messages it sends.
export type Fact = { step: number; left: { step: number; whole: boolean; message: number } | undefined; messages: number };

// The step each fact's request follows, in the facts' order, none for one that follows nothing: one thread's requests,
// or several threads' interleaved, since a request is placed by the step it left.
// [LAW:dataflow-not-control-flow] Every request is placed by the same rules, read off its fact and the steps before it:
// - a thread's first request follows nothing;
// - a request after the whole of `X` follows it;
// - a request that leaves inside what `X` added carries on what it edited (old tool results cleared, a changed message)
//   when it sends more messages than the newest step that carries `X` on, `X` itself where none does: it follows that
//   step;
// - any other that leaves inside what `X` added follows the nearest of the steps `X` follows, and so on up, whose reply
//   comes before the message it leaves in (a compaction, a probe, a side question, a reply regenerated).
// [LAW:no-ambient-temporal-coupling] What a request follows is decided by the requests before it alone, so a request
// arriving later moves none.
export function followsOf(facts: readonly Fact[]): (number | undefined)[] {
  const factOf = new Map(facts.map((fact) => [fact.step, fact]));
  const follows = new Map<number, number | undefined>();
  const carries = (step: number, from: number) => {
    for (let on: number | undefined = step; on !== undefined; on = follows.get(on)) if (on === from) return true;
    return false;
  };
  facts.forEach(({ step, left, messages }, index) => {
    if (left === undefined) return void follows.set(step, undefined);
    if (left.whole) return void follows.set(step, left.step);
    // Searched from the end, where the step it edits almost always is.
    const carrier = facts.slice(0, index).findLast((before) => carries(before.step, left.step))!;
    if (messages > carrier.messages) return void follows.set(step, carrier.step);
    let followed = follows.get(left.step);
    while (followed !== undefined && factOf.get(followed)!.messages >= left.message) followed = follows.get(followed);
    follows.set(step, followed);
  });
  return facts.map(({ step }) => follows.get(step));
}
