// Which line of its thread each request is on (docs/design/02-design.md, "Two axes"). A thread's requests are not one
// line: a side question, a compaction, a prompt suggestion or a twin subagent resends the thread and goes its own way, a
// branch, which looks, as it arrives, exactly like the thread's own next request; only the requests after it say which
// it was. So a request's line is decided again from every request's fact each time one arrives.

// Where a request leaves the requests of its thread before it: after the whole of `step`'s, its reply included
// (`whole`), or inside what `step` added. None for a thread's first request. `trace`: its exchange's trace_id, which
// names a line it begins. `messages`: how many messages it sends.
export type Fact = { step: number; trace: string; left: { step: number; whole: boolean } | undefined; messages: number };

// A request's line, by its key: `thread:<trace>`, a thread's main line, named by the exchange that began it, or
// `branch:<trace>`, named by the branch's first request; and, for a branch, the line it left, `base`, and
// the step on it it left from.
export type Role = { line: string; branch: { base: string; from: number } | undefined };

// A line: its steps in order, and, for a branch that left inside what its line's last request added, that request, whose
// place it takes once it is continued while that request is still its line's last. A line is a branch exactly when its
// first request left another, and it left from where that request left.
type Line = { steps: number[]; sibling: number | undefined };

// Each fact's role, in the facts' order: one thread's requests, or several threads' interleaved, since a request's line
// is found from the line holding the step it left. [LAW:dataflow-not-control-flow] Every request is placed by the same
// three rules, read off its fact:
// - a thread's first request begins its main line;
// - a request after the whole of another's continues that one's line, and the requests after that one on it, which it
//   does not resend, are a branch (a side question, a prompt suggestion, turns rewound);
// - a request that leaves inside what another added edits that line's history in place when it sends more messages than
//   the line's last request, carrying the line on past it (old tool results cleared, a changed system prompt), and is
//   otherwise a branch of its own off it (a compaction, a twin, a side request with a system prompt of its own).
// A branch off the line's last request and that request are alike to the line: each resends the line and goes its own
// way, as a side question and the thread's next turn do when the turn's new message begins as the question's did. The
// one continued, while the line has had nothing since, is the line's, and the other a branch.
export function linesOf(facts: readonly Fact[]): Role[] {
  const factOf = new Map(facts.map((fact) => [fact.step, fact]));
  const lineOf = new Map<number, Line>();
  const join = (line: Line, steps: number[]) => {
    line.steps.push(...steps);
    for (const step of steps) lineOf.set(step, line);
  };
  const begin = (steps: number[], sibling: number | undefined) => join({ steps: [], sibling }, steps);
  // The line a request after the whole of one of `line`'s continues: `line`, or, while its sibling is still its line's
  // last, the sibling's line, which `line`'s steps join as the sibling goes to a branch of its own.
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
    } else if (messages > factOf.get(last)!.messages) join(line, [step]);
    else begin([step], last === left.step && factOf.get(last)!.left !== undefined ? last : undefined);
  }
  // [LAW:one-source-of-truth] A line's key, and for a branch where it left from, are its first request's, and its base
  // the line that step is on, read at the end, since a later request can change which requests a line holds.
  const firstOf = (line: Line) => factOf.get(line.steps[0]!)!;
  const keyOf = (line: Line) => `${firstOf(line).left === undefined ? "thread" : "branch"}:${firstOf(line).trace}`;
  return facts.map(({ step }) => {
    const line = lineOf.get(step)!;
    const from = firstOf(line).left?.step;
    return { line: keyOf(line), branch: from === undefined ? undefined : { base: keyOf(lineOf.get(from)!), from } };
  });
}
