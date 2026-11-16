// Which line of its thread each request is on (docs/design/02-design.md, "Two axes"). A thread's requests are not one
// line: a side question, a compaction, a prompt suggestion or a twin subagent resends the thread and goes its own way, a
// branch, which looks, as it arrives, exactly like the thread's own next request; only the requests after it say which
// it was. So a request's line is decided again from every request's fact each time one arrives.

// Where a request leaves the requests of its thread before it: after the whole of `step`'s, its reply included
// (`whole`), or inside what `step` added. None for a thread's first request. `trace`: its exchange's trace_id, which
// names a line it begins. `messages`: how many messages it sends.
export type Fact = { step: number; trace: string; left: { step: number; whole: boolean } | undefined; messages: number };

// A request's line, by the prefix of its items' keys: `thread:<trace>`, a thread's main line, named by the exchange that
// began it, or `branch:<trace>`, named by the branch's first request; and, for a branch, the line it left, `base`, and
// the step on it it left from.
export type Role = { line: string; branch: { base: string; from: number } | undefined };

// A line: its key, its steps in order, and, for a branch, the step it left from; and, for a branch that left inside what
// its line's last request added, that line and request, whose place it takes once it is continued while the line has had
// nothing since.
type Line = { key: string; steps: number[]; from: number | undefined; sibling: { line: Line; step: number } | undefined };

// Each fact's role, in the facts' order: one thread's requests, or several threads' interleaved, since a request's line
// is found from the line holding the step it left. [LAW:dataflow-not-control-flow] Every request is placed by the same
// three rules, read off its fact:
// - a thread's first request begins its main line;
// - a request after the whole of another's continues that one's line, and the requests after that one on it, which it
//   does not resend, are a branch off it (a side question, a prompt suggestion, turns rewound);
// - a request that leaves inside what another added edits that line's history in place when it sends more messages than
//   the line's last request, carrying the line on past it (old tool results cleared, a changed system prompt), and is
//   otherwise a branch of its own off it (a compaction, a twin, a side request with a system prompt of its own).
// A branch off the line's last request and that request are alike to the line: each resends the line and goes its own
// way, as a side question and the thread's next turn do when the turn's new message begins as the question's did. The
// one continued, while the line has had nothing since, is the line's, and the other a branch.
export function linesOf(facts: readonly Fact[]): Role[] {
  const factOf = new Map(facts.map((fact) => [fact.step, fact]));
  const lineOf = new Map<number, Line>();
  const begin = (key: string, steps: number[], from: number | undefined, sibling: Line["sibling"]): Line => {
    const line: Line = { key, steps, from, sibling };
    for (const step of steps) lineOf.set(step, line);
    return line;
  };
  const join = (line: Line, steps: number[]) => {
    line.steps.push(...steps);
    for (const step of steps) lineOf.set(step, line);
  };
  for (const { step, trace, left, messages } of facts) {
    if (left === undefined) {
      begin(`thread:${trace}`, [step], undefined, undefined);
      continue;
    }
    const line = lineOf.get(left.step)!;
    const last = line.steps.at(-1)!;
    if (left.whole) {
      const { sibling } = line;
      if (sibling !== undefined && sibling.line.steps.at(-1) === sibling.step) {
        // The branch is continued and its sibling is still its line's last: the sibling goes, and the branch is the line's.
        const { left: siblingLeft } = factOf.get(sibling.step)!;
        begin(`branch:${factOf.get(sibling.step)!.trace}`, sibling.line.steps.splice(-1), siblingLeft!.step, undefined);
        join(sibling.line, line.steps.splice(0));
        join(sibling.line, [step]);
        continue;
      }
      const after = line.steps.splice(line.steps.indexOf(left.step) + 1);
      if (after.length > 0) begin(`branch:${factOf.get(after[0]!)!.trace}`, after, left.step, undefined);
      join(line, [step]);
    } else if (messages > factOf.get(last)!.messages) join(line, [step]);
    else {
      const siblings = last === left.step && factOf.get(last)!.left !== undefined;
      begin(`branch:${trace}`, [step], left.step, siblings ? { line, step: last } : undefined);
    }
  }
  // [LAW:one-source-of-truth] A branch's base is the line its step is on at the end, which a later request can change.
  return facts.map(({ step }) => {
    const { key, from } = lineOf.get(step)!;
    return { line: key, branch: from === undefined ? undefined : { base: lineOf.get(from)!.key, from } };
  });
}
