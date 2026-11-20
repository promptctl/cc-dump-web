import { describe } from "@cc-dump/log/describe";
import type { ByTrace } from "../src/exchanges.ts";
import { categories, launchName, type Category, type Launch } from "../src/format/blocks.ts";
import { createFormatter, type KeyedBlock } from "../src/format/format.ts";
import { senderOf } from "../src/format/wire.ts";
import type { Visibility } from "../src/settings.ts";
import { createHistory, firstMessageOf, levelKey, levelOf, placeOf, replyOf, saidIn, type After, type History, type Level } from "../src/view/history.ts";
import { blockIn, createLayout, nestKey, pastOf, type Doing, type Layout, type Parent, type Row } from "../src/view/rows.ts";
import { foldOf } from "./recording.ts";

// The column's promises (docs/design/02-design.md, "Two axes"), checked on recordings of real traffic, at every step,
// with every category listed and every nest open: `node packages/ui/check/column.ts <recording.jsonl>...`. It prints
// what each recording holds and each promise a step breaks, and fails if one did. A recording is read an event at a
// time, and an exchange's body events are let go once it is formatted, so what it holds is the formatted blocks, not
// the bodies' bytes. [LAW:verifiable-goals] It reads what the history says each step stands after, the keys and the
// selections it imports, and the column's rules as docs/design/02-design.md states them; it decides the rest itself,
// each rule stated anew over its own reading: the path, each step's level and depth, what a thread carries on from,
// and what each agent says on the wire, read here from the headers (format/wire.ts) and the blocks, never from what
// the history recorded of them (StepWire).

// What a recording holds: its steps, and each fork's, nest's and thread's line the column lists at some step, by its
// key, with what it says where it says the most.
type Found = { steps: number; forks: Map<string, string>; nests: Map<string, string>; threads: Map<string, string> };

// What one step says on the wire, read from its request's head and its blocks. `level`: its sender's. `parent`: the
// agent its parent header names. `answers`: the calls its results answer. `ties`: each agent a result or a
// notification of its names with the call that launched it, by what says so, `result` for a result, which only an
// Agent call answers. `notices`: its notifications that tell a stop, by their text. `waits`: the calls its reply waits
// on, where it stopped for a tool. `replied`: its reply's last block, none before its reply's first.
// `calls`: what each of its calls launches, by id. `end`: when its exchange ended.
type Said = {
  level: Level;
  parent: string | undefined;
  answers: Set<string>;
  ties: Map<string, { agent: string; call: string; result: boolean }>;
  notices: Map<string, { agent: string; status: string }>;
  waits: string[];
  replied: KeyedBlock | undefined;
  calls: Map<string, Launch | undefined>;
  end: string | undefined;
};

function saidOf({ formatted }: History["segments"][number]): Said {
  const blocks = formatted.groups.flatMap(({ blocks }) => blocks);
  const sender = senderOf(formatted.exchange.request.head);
  const said: Said = {
    level: levelOf(sender),
    parent: sender.kind === "agent" ? sender.parent : undefined,
    answers: new Set(),
    ties: new Map(),
    notices: new Map(),
    waits: [],
    replied: undefined,
    calls: new Map(),
    end: formatted.exchange.end?.timestamp,
  };
  const reply = replyOf(formatted);
  said.replied = reply.at(-1);
  if (formatted.facts.stopReason === "tool_use") for (const { call } of reply) if (call?.waits) said.waits.push(call.id);
  for (const { result, notice, call, parts } of blocks) {
    if (result !== undefined) said.answers.add(result.answers);
    if (result?.names !== undefined) said.ties.set(`result ${result.names} ${result.answers}`, { agent: result.names, call: result.answers, result: true });
    if (call !== undefined) said.calls.set(call.id, call.launches);
    if (notice?.kind !== "stop") continue;
    if (notice.call !== undefined) said.ties.set(`notice ${notice.agent} ${notice.call}`, { agent: notice.agent, call: notice.call, result: false });
    if (parts[0]?.kind === "text") said.notices.set(parts[0].text, notice);
  }
  return said;
}

// What a step's first message says (view/history.ts, saidIn), none while its request sends none.
const firstMessage = ({ segments }: History, step: number): string | undefined => {
  const blocks = firstMessageOf(segments[step - 1]!.formatted);
  return blocks.length === 0 ? undefined : saidIn(blocks);
};
// Whether two say one thing an agent is doing: both run, having done one last thing, or both rest, ended alike.
const sameDoing = (a: Doing, b: Doing) => (a.runs && b.runs ? a.latest === b.latest : !a.runs && !b.runs && a.ended === b.ended);
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((one, index) => one === b[index]);
const kindOf =
  <Kind extends Row["kind"]>(kind: Kind) =>
  (row: Row): row is Extract<Row, { kind: Kind }> =>
    row.kind === kind;
const top = levelKey({ kind: "main" });

// A tie a step makes: the step, the call it names, and what that call launches where one of that id that launches what
// the tie asks stands on the step's reach.
type Tied = { own: number; by: string; call: string; found: Launch | undefined };

function check(history: History, layoutAt: (step: number) => Layout): { found: Found; broken: string[] } {
  const { segments, stepOf } = history;
  const afterOf = (step: number): After | undefined => segments[step - 1]!.after;
  const traceOf = (step: number) => segments[step - 1]!.formatted.exchange.trace_id;
  const said = segments.map(saidOf);
  const sayOf = (step: number) => said[step - 1]!;
  const levelAt = (step: number) => levelKey(sayOf(step).level);
  // What each step stands after, by name, and the steps of the recording that stand after each thing: siblings.
  const places = segments.map(({ after }) => (after === undefined ? undefined : placeOf(after, segments)));
  const siblings = new Map<string, number[]>();
  places.forEach((place, index) => place !== undefined && siblings.set(place, siblings.get(place) ?? []).get(place)!.push(index + 1));

  // What the wire has said by now, kept as each step arrives, so a step's bookkeeping does not grow with the steps
  // before it. `firsts`: each subagent's level's first step. `named`: the agent its first step's parent header names.
  // `ties`: each subagent's, in the order their steps arrived, by a result or a notification the step it follows did
  // not send, with the level `by` that made it, found on its reach, it and the steps it stands after, a thread's
  // included: a tie can come before the agent's first step, so whether its parent's level made it is read when it
  // counts. `stopped`: each agent's last stop, at a step whose notification the step it follows did not send.
  // `answered`: the calls each agent's steps answer. `agents`: each agent's steps since its last stop.
  const firsts = new Map<string, number>();
  const named = new Map<string, string | undefined>();
  const ties = new Map<string, Tied[]>();
  const stopped = new Map<string, { own: number; status: string }>();
  const answered = new Map<string, Set<string>>();
  const agents = new Map<string, number[]>();
  const arrive = (own: number) => {
    const one = sayOf(own);
    const key = levelKey(one.level);
    if (!firsts.has(key) && key !== top) {
      firsts.set(key, own);
      named.set(key, one.parent);
    }
    const after = afterOf(own);
    const before = after?.on === "step" ? sayOf(after.step) : undefined;
    for (const [signature, { agent, call, result }] of one.ties) {
      if (before?.ties.has(signature)) continue;
      // The call of that id on its reach, the nearest; a result of another tool's call, as a Bash that prints one,
      // ties nothing.
      let on: number | undefined = own;
      while (on !== undefined && !sayOf(on).calls.has(call)) on = afterOf(on)?.step;
      const made = on === undefined ? undefined : { launches: sayOf(on).calls.get(call) };
      if (result && made !== undefined && made.launches?.tool !== "Agent") continue;
      const found = made?.launches;
      const tied = levelKey({ kind: "agent", id: agent });
      ties.set(tied, ties.get(tied) ?? []).get(tied)!.push({ own, by: key, call, found });
    }
    for (const [text, { agent, status }] of one.notices) {
      if (before?.notices.has(text)) continue;
      stopped.set(agent, { own, status });
      agents.set(agent, []);
    }
    if (one.level.kind !== "agent") return;
    const id = one.level.id;
    if (!answered.has(id)) answered.set(id, new Set());
    // A step answers its calls once its reply has begun, so the step waiting on them runs until it has.
    if (one.replied !== undefined || one.end !== undefined) for (const call of one.answers) answered.get(id)!.add(call);
    agents.set(id, agents.get(id) ?? []).get(id)!.push(own);
  };
  // Each subagent's parent by now: the level its parent header names, where that level has a step by now and the chain
  // of parent headers from it does not come back to this one, and the main agent's for any other.
  const parentsNow = () => {
    const parentKey = (key: string) => (named.get(key) === undefined ? undefined : levelKey({ kind: "agent", id: named.get(key)! }));
    const parents = new Map<string, string>();
    for (const key of firsts.keys()) {
      const at = parentKey(key);
      const seen = new Set<string>();
      let back = false;
      for (let on = at; on !== undefined && !seen.has(on) && !back; on = parentKey(on)) {
        back = on === key;
        seen.add(on);
      }
      parents.set(key, at !== undefined && firsts.has(at) && !back ? at : top);
    }
    return parents;
  };

  const found: Found = { steps: segments.length, forks: new Map(), nests: new Map(), threads: new Map() };
  const broken: string[] = [];
  for (let step = 1; step <= segments.length; step++) {
    const say = (what: string) => broken.push(`step ${step}: ${what}`);
    arrive(step);
    const parents = parentsNow();
    const depthOf = (key: string): number => (key === top ? 0 : 1 + depthOf(parents.get(key)!));
    const tiesBy = (key: string) => (ties.get(key) ?? []).filter(({ by }) => by === parents.get(key));
    // The chain of levels the chosen step is in, each reached at a step: its own at the chosen step, and each above at
    // the step of the latest tie by now that places the one below, where one does.
    const reached = new Set<number>();
    const chain: string[] = [];
    for (let key: string | undefined = levelAt(step), at: number | undefined = step; key !== undefined; key = parents.get(key)) {
      chain.push(key);
      if (at !== undefined) reached.add(at);
      at = tiesBy(key).findLast(({ found }) => found !== undefined)?.own;
    }
    // The path: a step that stands after nothing, and, of the siblings by now after a thing on it, the one under which
    // the latest step by now stands, a step reached at counting as later than every other.
    const latest = new Array<number>(step + 1).fill(0);
    for (let own = step; own >= 1; own--) {
      latest[own] = Math.max(latest[own]!, reached.has(own) ? step + 1 : own);
      const after = afterOf(own);
      if (after !== undefined) latest[after.step] = Math.max(latest[after.step]!, latest[own]!);
    }
    const path = new Set<number>();
    for (let own = 1; own <= step; own++) {
      const after = afterOf(own);
      if (after === undefined || (path.has(after.step) && siblings.get(places[own - 1]!)!.every((other) => other > step || latest[other]! <= latest[own]!))) path.add(own);
    }
    // What a thread on the path carries on from: the step whose summary it begins with, and each that one follows or
    // carries on.
    const carried = new Set<number>();
    for (const own of path) {
      const after = afterOf(own);
      for (let on = after?.on === "block" ? after.step : undefined; on !== undefined; on = afterOf(on)?.step) carried.add(on);
    }

    const { rows, every, steps } = layoutAt(step);
    const indexOf = new Map(rows.map(({ key }, index) => [key, index]));
    if (rows.length !== every.rows.length) say(`${every.rows.length - rows.length} rows are not listed with every category listed and every nest open`);
    if (indexOf.size !== rows.length) say("two rows have one key");
    // A step is dimmed where a thread on the path carries it on, or the nest its level's rows stand in is.
    const nestOf = (key: string) => rows[indexOf.get(nestKey(sayOf(firsts.get(key)!).level)) ?? -1] as Extract<Row, { kind: "nest" }> | undefined;
    const isDimmed = (own: number) => carried.has(own) || (levelAt(own) !== top && nestOf(levelAt(own))?.dimmed === true);

    // The column lists the path, the chosen step on it, one step after each thing, each step's line once.
    const listed = [...steps].sort((a, b) => a - b);
    if (!steps.has(step)) say("the chosen step is not listed");
    if (!sameList(listed, [...path])) say(`the column lists steps ${listed.join(" ")} where the path is ${[...path].join(" ")}`);
    const taken = new Set<string>();
    for (const own of listed) {
      const place = places[own - 1];
      if (place === undefined) continue;
      if (taken.has(place)) say(`two listed steps stand after ${place}`);
      taken.add(place);
    }
    const lines = rows.filter(kindOf("exchange"));
    if (!sameList(lines.map(({ key }) => stepOf(key)).sort((a, b) => a! - b!), listed)) say("the exchanges' lines are not the listed steps', one each");
    for (const line of lines) {
      const own = stepOf(line.key)!;
      if ((line.change === "added") !== (own === step)) say(`${line.key}'s line is ${line.change}`);
      if (line.depth !== depthOf(levelAt(own))) say(`${line.key}'s line is ${line.depth} in where its level is ${depthOf(levelAt(own))} in`);
      if (line.dimmed !== isDimmed(own)) say(`${line.key}'s line is ${line.dimmed ? "" : "not "}dimmed`);
    }

    // A block's row shows the last version a step on the path gave it, its past is the path's, and only the step
    // shown marks it.
    for (const row of rows.filter(kindOf("block"))) {
      const version = row.versions[row.at]!;
      const own = row.versions[0]!.step;
      if (!path.has(version.step)) say(`${row.key} shows a version of step ${version.step}, which is off the path`);
      if (row.versions.some((later, index) => index > row.at && path.has(later.step))) say(`${row.key} shows a version before the last the path gave it`);
      if ((row.change !== "same") !== (version.step === step)) say(`${row.key} is ${row.change} and shows a version of step ${version.step}`);
      for (const event of pastOf(row)) if (!path.has(event.step)) say(`${row.key}'s past holds step ${event.step}, which is off the path`);
      if (!path.has(own)) say(`${row.key} arrived with step ${own}, which is off the path`);
      else if (row.depth !== depthOf(levelAt(own)) || row.dimmed !== isDimmed(own)) say(`${row.key} does not stand as its step ${own} does`);
    }

    // A fork's line stands at each place the recording has siblings, once what they stand after is listed, a step, or
    // one of them is, for those that hang on a block; it lists them all, and the one on the path.
    const forks = rows.filter(kindOf("fork"));
    const parting = [...siblings].filter(([, own]) => own.length > 1 && (afterOf(own[0]!)!.on === "step" ? path.has(afterOf(own[0]!)!.step) : own.some((one) => path.has(one))));
    if (!sameList(forks.map(({ key }) => key).sort(), parting.map(([place]) => `${place}/fork`).sort())) say(`the fork lines are ${forks.map(({ key }) => key).join(" ")} where histories part after ${parting.map(([place]) => place).join(" ")}`);
    for (const fork of forks) {
      found.forks.set(fork.key, `${fork.depth} in, steps ${fork.siblings.map((sibling) => sibling.step).join(" ")}`);
      const own = siblings.get(fork.key.slice(0, -"/fork".length));
      if (own === undefined) continue;
      const after = afterOf(own[0]!)!;
      const at = indexOf.get(fork.key)!;
      const shown = own.find((one) => path.has(one));
      if (!sameList(fork.siblings.map((sibling) => sibling.step), own)) say(`${fork.key} lists ${fork.siblings.map((sibling) => sibling.step).join(" ")} where the siblings are ${own.join(" ")}`);
      if (fork.shown !== shown) say(`${fork.key} says step ${fork.shown} is listed where step ${shown} is`);
      if (shown !== undefined && !(indexOf.get(traceOf(shown))! > at)) say(`${fork.key} does not stand above its sibling ${shown}`);
      if (after.on === "step") {
        // After the step's rows and what hangs on them, before any other step of its level.
        const from = indexOf.get(traceOf(after.step));
        const line = from === undefined ? undefined : rows[from]!;
        if (line === undefined || from! > at || fork.depth !== line.depth || fork.dimmed !== line.dimmed) say(`${fork.key} does not stand under its step as the step stands`);
        else if (rows.slice(from! + 1, at).some((row) => row.kind === "exchange" && row.depth <= fork.depth)) say(`${fork.key} stands after another step's rows`);
      } else {
        // First under the line of the thread it hangs on, level with it.
        const line = rows[at - 1];
        if (line?.key !== `${after.key}/${after.as}` || fork.depth !== line.depth) say(`${fork.key} is not first under the ${after.as}'s line`);
      }
    }

    // Each level with a step by now has a nest's line, as deep as its parent's rows, holding its listed steps one level
    // in, in the order they arrived; it stands right after the call its latest tie by a listed step names, past the
    // nests before it there, or, while no listed step ties it, at its parent's end.
    const nests = rows.filter(kindOf("nest"));
    const levels = [...firsts].filter(([, own]) => own <= step);
    if (!sameList(nests.map(({ key }) => key).sort(), levels.map(([, own]) => nestKey(sayOf(own).level)).sort())) say(`the nests' lines are ${nests.map(({ key }) => key).join(" ")} where the levels by now are ${levels.map(([key]) => key).join(" ")}`);
    const doingNow = doingOf(said, step, { stopped, answered, agents });
    for (const [key, own] of levels) {
      const level = sayOf(own).level;
      const nest = nests.find((one) => one.key === nestKey(level));
      if (nest === undefined) continue;
      const at = indexOf.get(nest.key)!;
      if (nest.depth !== depthOf(parents.get(key)!)) say(`${nest.key} is ${nest.depth} in where its parent's rows are ${depthOf(parents.get(key)!)} in`);
      if (nest.level.kind !== level.kind) say(`${nest.key} says its level is ${nest.level.kind}'s`);
      if (nest.prompt !== firstMessage(history, own)) say(`${nest.key} does not say what its first step's first message says`);
      if (nest.change !== (own === step ? "added" : chain.includes(key) ? "changed" : "same")) say(`${nest.key} is ${nest.change}`);
      const next = rows.findIndex((row, index) => index > at && row.depth <= nest.depth);
      const end = next === -1 ? rows.length : next;
      const inside = rows.slice(at + 1, end).filter((row) => row.kind === "exchange" && row.depth === nest.depth + 1).map(({ key }) => stepOf(key));
      const holds = [...path].filter((one) => levelAt(one) === key);
      if (!sameList(inside, holds)) say(`${nest.key} holds steps ${inside.join(" ")} where its level's listed are ${holds.join(" ")}`);
      if (nest.count !== holds.length) say(`${nest.key} counts ${nest.count} steps of ${holds.length}`);
      const atEnd = () => end < rows.length && rows[end]!.depth === nest.depth && rows[end]!.kind !== "nest" && say(`${nest.key} stands before ${rows[end]!.key}, not at its parent's end`);
      if (nest.level.kind === "unread") {
        if (!found.nests.has(nest.key)) found.nests.set(nest.key, `${nest.depth} in, sender not read, ${nest.count} steps`);
        atEnd();
        continue;
      }
      const { parent, stands, doing } = nest.level;
      if (stands.kind === "tied" || !found.nests.has(nest.key)) found.nests.set(nest.key, `${nest.depth} in, ${stands.kind === "tied" ? (stands.launches ?? "an agent") : "untied"}, ${nest.count} steps`);
      const id = named.get(key);
      const expected: Parent = id === undefined ? { kind: "main" } : parents.get(key) === top ? { kind: "unrecorded", named: id } : { kind: "agent", id };
      if (JSON.stringify(parent) !== JSON.stringify(expected)) say(`${nest.key} says its parent is ${JSON.stringify(parent)} where it is ${JSON.stringify(expected)}`);
      // The ties listed steps made, of which the latest found places the nest.
      const tied = tiesBy(key).filter(({ own }) => path.has(own));
      const placed = tied.findLast(({ found }) => found !== undefined);
      if (placed === undefined) {
        if (stands.kind === "tied") say(`${nest.key} is tied to ${stands.call} where no listed step ties it`);
        else if (stands.unfound !== (tied.length > 0 && tied.at(-1)!.found === undefined)) say(`${nest.key} says its latest listed tie is ${stands.unfound ? "" : "not "}unfound`);
        // At its parent's end, it stands as the parent's rows do: as the parent's nest, or undimmed at the main agent's.
        const parentKey = parents.get(key)!;
        if (nest.dimmed !== (parentKey !== top && nestOf(parentKey)?.dimmed === true)) say(`${nest.key} does not stand as its parent's rows do`);
        atEnd();
      } else {
        let before = at - 1;
        while (before >= 0 && (rows[before]!.depth > nest.depth || (rows[before]!.kind === "nest" && rows[before]!.depth === nest.depth))) before--;
        const call = rows[before];
        if (call?.kind !== "block" || blockIn(call.versions[0]!).call?.id !== placed.call || stands.kind !== "tied" || stands.call !== call.key) say(`${nest.key} does not stand right after the call ${placed.call} its step ${placed.own} ties it to`);
        else if (nest.depth !== call.depth || nest.dimmed !== call.dimmed) say(`${nest.key} does not stand as its call does`);
        if (stands.kind === "tied" && stands.launches !== launchName(placed.found!)) say(`${nest.key} does not say what its call launches`);
      }
      const does = doingNow.get(nest.level.id)!;
      const says = (one: Doing) => (one.runs ? `runs, ${one.latest?.name ?? "nothing yet"}` : `rests, ${one.ended ?? "no stop"}`);
      if (!sameDoing(doing, does)) say(`${nest.key} says it ${says(doing)} where its agent ${says(does)}`);
    }

    // A thread's line stands right after the block whose summary the thread on the path begins with, level with it,
    // above the thread's first step.
    const threads = rows.filter(kindOf("thread"));
    const carrying = [...path].filter((own) => afterOf(own)?.on === "block");
    const threadKey = (own: number) => `${(afterOf(own) as Extract<After, { on: "block" }>).key}/thread`;
    if (!sameList(threads.map(({ key }) => key).sort(), carrying.map(threadKey).sort())) say("the threads' lines are not those of the threads on the path that carry a summary on");
    for (const thread of threads) {
      found.threads.set(thread.key, `${thread.depth} in`);
      const own = carrying.find((one) => threadKey(one) === thread.key);
      if (own === undefined) continue;
      const at = indexOf.get(thread.key)!;
      const block = rows[at - 1];
      if (block?.kind !== "block" || `${block.key}/thread` !== thread.key) {
        say(`${thread.key} does not stand right after its block`);
        continue;
      }
      const { summary } = blockIn(block.versions[0]!);
      if (summary === undefined || firstMessage(history, own)?.includes(summary) !== true) say(`${thread.key} stands after a block whose summary step ${own} does not begin with`);
      if (thread.depth !== block.depth || !block.dimmed) say(`${thread.key} is not level with its block, or its block is not dimmed`);
      if (!(indexOf.get(traceOf(own))! > at) || thread.change === "added" !== (own === step)) say(`${thread.key} does not stand above its thread's first step ${own}, or is ${thread.change}`);
    }
  }
  return { found, broken };
}

// What each agent is doing at step `step`, by its id. Of its steps by now after the last that stops it, it runs while
// one's reply has not ended by the time the chosen step's had (the chosen one not ended: now), or waits on a call no
// step of it by now answers; and, while it runs, the newest of those running replies that did something says what it
// last did. It rests as its last stop by now says it ended.
function doingOf(
  said: readonly Said[],
  step: number,
  { stopped, answered, agents }: { stopped: ReadonlyMap<string, { status: string }>; answered: ReadonlyMap<string, ReadonlySet<string>>; agents: ReadonlyMap<string, readonly number[]> },
): Map<string, Doing> {
  const ended = said[step - 1]!.end;
  const now = ended === undefined ? undefined : new Date(ended).getTime();
  return new Map(
    [...agents].map(([id, steps]): [string, Doing] => {
      const running = steps.filter((own) => {
        const { end, waits } = said[own - 1]!;
        return end === undefined || (now !== undefined && new Date(end).getTime() > now) || waits.some((call) => !answered.get(id)?.has(call));
      });
      if (running.length === 0) return [id, { runs: false, ended: stopped.get(id)?.status }];
      // The SubagentHandback that hands the report back ends the agent's work and is none of it.
      const did = running.map((own) => said[own - 1]!.replied).findLast((block) => block !== undefined && block.call?.waits !== false);
      return [id, { runs: true, latest: did }];
    }),
  );
}

// A recording's history, read an event at a time: each exchange is formatted as it ends, and its body's events let go,
// and what a write cut short left after its last whole event is said and not read. [LAW:no-ambient-temporal-coupling]
// That is sound because a trace takes nothing after its end (exchanges.ts, add): the formatter keeps what it made of
// each side under the side's latest event (format/format.ts), so an ended exchange is read from that, never from its
// emptied body again.
async function historyOf(recording: string): Promise<History> {
  const byTrace: ByTrace = new Map();
  const format = createFormatter();
  const { unterminated, events } = foldOf(recording, byTrace);
  if (unterminated > 0) console.log(`${recording}: its last ${unterminated} bytes are cut off, and not read`);
  for await (const { exchange } of events) {
    if (exchange.latest.type !== "end") continue;
    format([...byTrace.values()]);
    exchange.request.body.length = 0;
    exchange.response.body.length = 0;
  }
  return createHistory()(format([...byTrace.values()]));
}

const expanded = Object.fromEntries(categories.map((category) => [category, "expanded"])) as Record<Category, Visibility>;
if (process.argv.length < 3) throw new Error("Give the recordings to check: node packages/ui/check/column.ts <recording.jsonl>...");
let failed = false;
for (const recording of process.argv.slice(2)) {
  // A recording that cannot be read is reported by its name, and the next is checked.
  try {
    const history = await historyOf(recording);
    const open = Object.fromEntries(history.segments.map(({ formatted }) => [nestKey(levelOf(senderOf(formatted.exchange.request.head))), true]));
    const layOut = createLayout(expanded);
    const { found, broken } = check(history, (step) => layOut(history, step, undefined, open));
    console.log(`${recording}: ${found.steps} steps, ${found.forks.size} forks, ${found.nests.size} nests, ${found.threads.size} threads: ${broken.length === 0 ? "every promise kept" : `${broken.length} broken`}`);
    for (const [key, says] of [...found.forks, ...found.nests, ...found.threads]) console.log(`  ${key}: ${says}`);
    for (const what of broken.slice(0, 40)) console.error(`  ${what}`);
    failed ||= broken.length > 0;
  } catch (error) {
    console.error(`${recording}: ${describe(error)}`);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
