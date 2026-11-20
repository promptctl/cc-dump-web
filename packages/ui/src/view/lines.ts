// The step each request follows in its thread (docs/design/02-design.md, "Two axes"). A thread's requests are not one
// line: a side question, a compaction or a probe resends part of the thread and goes its own way. So
// each request stands after one of the requests before it, the last whose whole, reply included, it resends, and the
// requests standing after one are siblings, of which the column lists one.

// Where a request leaves the requests of its thread before it: after the whole of `step`'s, its reply included
// (`whole`), or inside what `step` added, and at which of the messages it sends it first differs, `message`, the
// reply's index for one that differs in none. None for a thread's first request. `messages`: how many messages it sends.
export type Fact = { step: number; left: { step: number; whole: boolean; message: number } | undefined; messages: number };

// A line: a request and the requests that carried it on, in order, and, for one that left inside what its line's last
// request added, that request, whose place it takes once it is continued while that request is still its line's last.
type Line = { steps: number[]; sibling: number | undefined };

// The step each fact's request follows, in the facts' order, none for one that follows nothing: one thread's requests,
// or several threads' interleaved, since a request is placed by the line holding the step it left.
// [LAW:dataflow-not-control-flow] Every request is placed by the same rules, read off its fact:
// - a thread's first request follows nothing;
// - a request after the whole of another's follows it;
// - a request that leaves inside what another added edits its line's history in place when it sends more messages than
//   the line's last request, and follows that last (old tool results cleared, a changed message);
// - any other that leaves inside what `X` added follows the nearest of the steps `X` follows, and so on up, whose reply
//   comes before the message it leaves in (a compaction, a probe, a side question), so one that leaves in the thread's
//   second message follows nothing.
// [LAW:no-ambient-temporal-coupling] What a request follows is decided by the requests before it alone, so a request
// arriving later moves none: only which line an edit carries on is kept between them, and of two requests that each
// resend a line and go their own way, the one continued while the line has had nothing since is the line's.
export function followsOf(facts: readonly Fact[]): (number | undefined)[] {
  const factOf = new Map(facts.map((fact) => [fact.step, fact]));
  const lineOf = new Map<number, Line>();
  const follows = new Map<number, number | undefined>();
  const join = (line: Line, steps: number[]) => {
    line.steps.push(...steps);
    for (const step of steps) lineOf.set(step, line);
  };
  const begin = (steps: number[], sibling: number | undefined) => join({ steps: [], sibling }, steps);
  // The line a request after the whole of one of `line`'s carries on: `line`, or, while its sibling is still its line's
  // last, the sibling's line, which `line`'s steps join as the sibling goes to a line of its own.
  const continued = (line: Line): Line => {
    const siblings = line.sibling === undefined ? undefined : lineOf.get(line.sibling)!;
    if (siblings === undefined || siblings.steps.at(-1) !== line.sibling) return line;
    begin(siblings.steps.splice(-1), undefined);
    join(siblings, line.steps.splice(0));
    return siblings;
  };
  for (const { step, left, messages } of facts) {
    if (left === undefined) {
      begin([step], undefined);
      follows.set(step, undefined);
      continue;
    }
    const line = lineOf.get(left.step)!;
    const last = line.steps.at(-1)!;
    if (left.whole) {
      const on = continued(line);
      // Searched from the end, where a request almost always leaves its line.
      const after = on.steps.splice(on.steps.lastIndexOf(left.step) + 1);
      if (after.length > 0) begin(after, undefined);
      join(on, [step]);
      follows.set(step, left.step);
    } else if (messages > factOf.get(last)!.messages) {
      join(line, [step]);
      follows.set(step, last);
    } else {
      begin([step], last === left.step && factOf.get(last)!.left !== undefined ? last : undefined);
      let followed = follows.get(left.step);
      while (followed !== undefined && factOf.get(followed)!.messages >= left.message) followed = follows.get(followed);
      follows.set(step, followed);
    }
  }
  return facts.map(({ step }) => follows.get(step));
}
