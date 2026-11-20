import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { exchanges } from "../src/exchanges.ts";
import { categories, type Category } from "../src/format/blocks.ts";
import { createFormatter, type FormattedExchange, type KeyedBlock } from "../src/format/format.ts";
import type { Visibility } from "../src/settings.ts";
import { createHistory, type After, type History } from "../src/view/history.ts";
import { blockOf, createLayout, nestKey, nestsOf, pastOf, type BlockRow, type Layout, type Row } from "../src/view/rows.ts";

// The column's promises (docs/design/02-design.md, "Two axes"), checked on recordings of real traffic, at every step,
// with every category listed and every nest open: `node packages/ui/check/column.ts <recording.jsonl>...`. It prints
// what each recording holds and each promise a step breaks, and fails if one did.
// [LAW:verifiable-goals] It reads what the history says each step stands after, which content decides, and decides the
// rest itself: the path, what a thread carries on from, and, from the wire alone (wireOf), who sent each step, where
// each subagent stands and whether it runs. So it shares the layout's premises and none of its working.

// What a recording holds: its steps, and each fork's, nest's and thread's line the column lists at some step, by its
// key, with what it says where it says the most.
type Found = { steps: number; forks: Map<string, string>; nests: Map<string, string>; threads: Map<string, string> };

// The block an item arrived as, which says what it sums up.
const first = ({ versions }: Pick<BlockRow, "versions">): KeyedBlock => {
  const version = versions[0]!;
  return version.block === undefined ? version.was : version.block;
};
const textsOf = ({ parts }: KeyedBlock): string[] => parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
// What a step's first message says: its texts, less those the harness injected.
const firstMessage = ({ segments }: History, step: number): string =>
  (segments[step - 1]!.formatted.groups.find(({ key }) => key === "message.0")?.blocks ?? []).flatMap((block) => (block.injected === undefined ? textsOf(block) : [])).join("");
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((one, index) => one === b[index]);
const kindOf =
  <Kind extends Row["kind"]>(kind: Kind) =>
  (row: Row): row is Extract<Row, { kind: Kind }> =>
    row.kind === kind;

// A subagent as the wire says it: the steps sent under its id; its parent, the agent the first of them names as its
// launcher where that agent sent a step before, and the main agent (none) otherwise; the step whose request first
// carries a result of an Agent call, or a notification of its stop, that names it with the id of the Agent or Skill
// call that launched it; and the steps whose requests first carry a
// notification of its stop, by where that notification stands in its sender's messages, or its foreground result.
type WireAgent = { steps: number[]; parent: string | undefined; named: { step: number; call: string } | undefined; stops: number[] };
// A reply of a subagent's: its step, when its exchange ended, why it stopped, the ids of the calls it makes but its
// handback, and its last block.
type Reply = { step: number; ended: number | undefined; stopReason: string | undefined; calls: string[]; last: KeyedBlock | undefined };
// `calledAt`: the step whose reply first makes each call, by its id.
type Wire = {
  agents: Map<string, WireAgent>;
  calledAt: Map<string, number>;
  senderIdOf: (step: number) => string | undefined;
  doing: (agent: string, step: number) => { runs: boolean; latest: KeyedBlock | undefined };
};

// What the wire says of the recording's agents, read off each exchange's sender and its blocks' ids (format/wire.ts),
// which every request resends whole: so each is taken where it first arrives.
function wireOf(formatted: readonly FormattedExchange[]): Wire {
  const agents = new Map<string, WireAgent>();
  const replies = new Map<string, Reply[]>();
  // The step at which each call's result is first sent, by the call's id.
  const answered = new Map<string, number>();
  const launchers = new Set<string>();
  const calledAt = new Map<string, number>();
  const notices = new Set<string>();
  const ended = ({ exchange: { end } }: FormattedExchange) => (end === undefined ? undefined : Date.parse(end.timestamp));
  formatted.forEach((exchange, index) => {
    const step = index + 1;
    const { sender, groups, facts } = exchange;
    const id = sender.kind === "subagent" ? sender.id : undefined;
    if (sender.kind === "subagent") {
      const agent = agents.get(sender.id) ?? { steps: [], parent: sender.parent !== undefined && agents.has(sender.parent) ? sender.parent : undefined, named: undefined, stops: [] };
      agent.steps.push(step);
      agents.set(sender.id, agent);
    }
    const blocks = groups.flatMap((group) => group.blocks);
    for (const { stated, place } of blocks) {
      if (stated?.kind !== "call") continue;
      if ("launch" in stated.tool) launchers.add(stated.id);
      if (place?.in === "reply" && !calledAt.has(stated.id)) calledAt.set(stated.id, step);
    }
    for (const block of blocks) {
      const { stated, place } = block;
      if (stated?.kind === "result" && place?.in !== "reply") {
        if (!answered.has(stated.answers)) answered.set(stated.answers, step);
        if (stated.named === undefined || !launchers.has(stated.answers)) continue;
        const agent = agents.get(stated.named.agent) ?? { steps: [], parent: undefined, named: undefined, stops: [] };
        agents.set(stated.named.agent, agent);
        if (agent.named !== undefined) continue;
        agent.named = { step, call: stated.answers };
        if (stated.named.ran === "foreground") agent.stops.push(step);
      }
      if (stated?.kind === "notified") {
        const notice = `${id ?? "main"} ${JSON.stringify(place)} ${block.key}`;
        if (notices.has(notice)) continue;
        notices.add(notice);
        for (const stop of stated.stops) {
          const agent = agents.get(stop.agent) ?? { steps: [], parent: undefined, named: undefined, stops: [] };
          agents.set(stop.agent, agent);
          agent.stops.push(step);
          if (agent.named === undefined && launchers.has(stop.call)) agent.named = { step, call: stop.call };
        }
      }
    }
    if (id === undefined) return;
    const reply = blocks.filter(({ place }) => place?.in === "reply");
    const calls = reply.flatMap(({ stated }) => (stated?.kind === "call" && stated.tool.name !== "SubagentHandback" ? [stated.id] : []));
    replies.set(id, [...(replies.get(id) ?? []), { step, ended: ended(exchange), stopReason: facts.stopReason, calls, last: reply.at(-1) }]);
  });
  // An agent named or stopped that sent no step is none the column shows.
  for (const [id, agent] of agents) if (agent.steps.length === 0) agents.delete(id);
  return {
    agents,
    calledAt,
    senderIdOf: (step) => {
      const { sender } = formatted[step - 1]!;
      return sender.kind === "subagent" ? sender.id : undefined;
    },
    // Whether an agent runs at step `step`, and its newest waiting reply's last block: a reply waits while it is still
    // coming then, or stopped for a call whose result no request had sent by then, and no stop since ended it.
    doing: (agent, step) => {
      const moment = ended(formatted[step - 1]!) ?? Infinity;
      const { stops } = agents.get(agent)!;
      let runs = false;
      let latest: KeyedBlock | undefined;
      for (const reply of replies.get(agent) ?? []) {
        if (reply.step > step) break;
        const coming = reply.ended === undefined || reply.ended > moment;
        const onTool = reply.stopReason === "tool_use" && reply.calls.some((call) => !((answered.get(call) ?? Infinity) <= step));
        if (!(coming || onTool) || stops.some((at) => at > reply.step && at <= step)) continue;
        runs = true;
        latest = reply.last ?? latest;
      }
      return { runs, latest };
    },
  };
}

function check(history: History, layoutAt: (step: number) => Layout): { found: Found; broken: string[] } {
  const { segments, stepOf } = history;
  const afterOf = (step: number): After | undefined => segments[step - 1]!.after;
  const traceOf = (step: number) => segments[step - 1]!.formatted.exchange.trace_id;
  // What each step stands after, by name, and the steps of the recording that stand after each thing: siblings.
  const places = segments.map(({ after }) => (after === undefined ? undefined : after.on === "step" ? traceOf(after.step) : after.key));
  const siblings = new Map<string, number[]>();
  places.forEach((place, index) => place !== undefined && siblings.set(place, [...(siblings.get(place) ?? []), index + 1]));
  const wire = wireOf(segments.map(({ formatted }) => formatted));
  const { senderIdOf } = wire;

  const found: Found = { steps: segments.length, forks: new Map(), nests: new Map(), threads: new Map() };
  const broken: string[] = [];
  for (let step = 1; step <= segments.length; step++) {
    const say = (what: string) => broken.push(`step ${step}: ${what}`);
    // Where a subagent's level stands at the step, by the wire: under its naming call's step once a request has carried
    // the result, or at its parent's level's end. How far in a step stands, and whether it is dimmed, follow.
    const standsOn = (agent: string): { call: number } | { parent: string | undefined } => {
      const { named, parent } = wire.agents.get(agent)!;
      const call = named === undefined || named.step > step ? undefined : wire.calledAt.get(named.call);
      return call === undefined ? { parent } : { call };
    };
    const levelDepth = (agent: string | undefined): number => {
      if (agent === undefined) return 0;
      const on = standsOn(agent);
      return 1 + ("call" in on ? depthOf(on.call) : levelDepth(on.parent));
    };
    const depthOf = (own: number): number => levelDepth(senderIdOf(own));
    // The path to the step: a step that stands after nothing, and, of the siblings that have arrived after a thing on
    // it, the one the latest step by now stands under.
    const latest = new Array<number>(step + 1).fill(0);
    for (let own = 1; own <= step; own++) for (let up: number | undefined = own; up !== undefined; up = afterOf(up)?.step) latest[up] = own;
    const path = new Set<number>();
    for (let own = 1; own <= step; own++) {
      const after = afterOf(own);
      if (after === undefined || (path.has(after.step) && siblings.get(places[own - 1]!)!.every((other) => other > step || latest[other]! <= latest[own]!))) path.add(own);
    }
    // A subagent's steps are on the path where what it stands in is: its call's step, or its parent's level.
    const levelListed = (agent: string | undefined): boolean => {
      if (agent === undefined) return true;
      const on = standsOn(agent);
      return "call" in on ? path.has(on.call) && levelListed(senderIdOf(on.call)) : levelListed(on.parent);
    };
    for (const own of [...path]) if (!levelListed(senderIdOf(own))) path.delete(own);
    // What a thread on the path carries on from: the step whose summary it begins with, and each that one follows
    // or carries on. A step is dimmed when it is one, or what its level stands in is.
    const carried = new Set<number>();
    for (const own of path) {
      const after = afterOf(own);
      for (let on = after?.on === "summary" ? after.step : undefined; on !== undefined; on = afterOf(on)?.step) carried.add(on);
    }
    const levelDimmed = (agent: string | undefined): boolean => {
      if (agent === undefined) return false;
      const on = standsOn(agent);
      return "call" in on ? isDimmed(on.call) : levelDimmed(on.parent);
    };
    const isDimmed = (own: number): boolean => carried.has(own) || levelDimmed(senderIdOf(own));

    const { rows, every, steps } = layoutAt(step);
    const indexOf = new Map(rows.map(({ key }, index) => [key, index]));
    if (rows.length !== every.rows.length) say(`${every.rows.length - rows.length} rows are not listed with every category listed and every nest open`);
    if (indexOf.size !== rows.length) say("two rows have one key");

    // The column lists the path, one step after each thing, each step's line once.
    const listed = [...steps].sort((a, b) => a - b);
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
      if (line.depth !== depthOf(own)) say(`${line.key}'s line is ${line.depth} in where its step is ${depthOf(own)} in`);
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
      else if (row.depth !== depthOf(own) || row.dimmed !== isDimmed(own)) say(`${row.key} does not stand as its step ${own} does`);
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
        // First under the thread's line, level with it.
        const line = rows[at - 1];
        if (line?.key !== `${after.key}/thread` || fork.depth !== line.depth) say(`${fork.key} is not first under the thread's line`);
      }
    }

    // [LAW:verifiable-goals] The nests, checked against the wire alone (wireOf): never against where the history or the
    // layout says a subagent stands. Each subagent whose first step has arrived has one line, where what it stands in
    // is listed: under the row of the Agent call whose result names it, once a request has carried that result, and at
    // the end of its parent's level before; it holds, one level in, exactly the listed steps sent under its id, and
    // says whether it runs, and what it last did, as its replies, results and stops by now say.
    const nests = rows.filter(kindOf("nest"));
    const nestAt = new Map(nests.map((nest) => [nest.agent, indexOf.get(nest.key)!]));
    if (nestAt.size !== nests.length) say("two nests' lines are one agent's");
    for (const nest of nests) {
      found.nests.set(nest.key, `${nest.depth} in, ${nest.launch?.type ?? "an agent"}, ${nest.count} steps${nest.launch === undefined ? ", not yet tied" : ""}`);
      const agent = wire.agents.get(nest.agent);
      if (agent === undefined || agent.steps[0]! > step) {
        say(`${nest.key} is the line of an agent no listed step sent as`);
        continue;
      }
      const at = indexOf.get(nest.key)!;
      const named = agent.named !== undefined && agent.named.step <= step ? agent.named : undefined;
      if ((nest.launch === undefined) !== (named === undefined)) say(`${nest.key} ${named === undefined ? "says a call before a result names its agent" : `says no call where step ${named.step} carried the result naming its agent`}`);
      if (named !== undefined) {
        const call = rows[at - 1];
        const id = call?.kind === "block" ? blockOf(call).stated : undefined;
        if (id?.kind !== "call" || id.id !== named.call) say(`${nest.key} does not stand right after the row of call ${named.call}, whose result names its agent`);
        else if (nest.depth !== call!.depth || nest.dimmed !== call!.dimmed) say(`${nest.key} does not stand as its call does`);
      } else {
        // At its parent's level's end: one level in under the parent's nest's line, after every listed step of it.
        const parentAt = agent.parent === undefined ? -1 : nestAt.get(agent.parent);
        if (parentAt === undefined) say(`${nest.key} stands at the end of agent ${agent.parent}'s level, which is not listed`);
        else {
          const depth = parentAt === -1 ? 0 : rows[parentAt]!.depth + 1;
          const parentSteps = rows.flatMap((row, index) => (row.kind === "exchange" && senderIdOf(stepOf(row.key)!) === agent.parent ? [index] : []));
          if (nest.depth !== depth) say(`${nest.key} is ${nest.depth} in where its parent's level is ${depth} in`);
          if (parentSteps.some((index) => index > at) || at < parentAt) say(`${nest.key} does not stand at the end of its parent's level`);
        }
      }
      const next = rows.findIndex((row, index) => index > at && row.depth <= nest.depth);
      const end = next === -1 ? rows.length : next;
      const inside = rows.slice(at + 1, end).filter((row) => row.kind === "exchange" && row.depth === nest.depth + 1).map(({ key }) => stepOf(key)!);
      const sent = agent.steps.filter((own) => path.has(own));
      if (!sameList(inside, sent)) say(`${nest.key} holds steps ${inside.join(" ")} where those listed sent as ${nest.agent} are ${sent.join(" ")}`);
      if (nest.count !== sent.length) say(`${nest.key} counts ${nest.count} steps of ${sent.length}`);
      const { runs, latest } = wire.doing(nest.agent, step);
      if (nest.runs !== runs || nest.latest !== latest) say(`${nest.key} ${nest.runs ? "runs" : "is done"}, saying ${nest.latest?.name ?? "nothing"}, where its agent ${runs ? "runs" : "is done"}, having last done ${latest?.name ?? "nothing"}`);
    }
    for (const [id, agent] of wire.agents) {
      if (agent.steps[0]! > step || nestAt.has(id)) continue;
      const named = agent.named !== undefined && agent.named.step <= step ? agent.named : undefined;
      const listed = named !== undefined ? rows.some((row) => row.kind === "block" && blockOf(row).stated?.kind === "call" && (blockOf(row).stated as { id: string }).id === named.call) : agent.parent === undefined || nestAt.has(agent.parent);
      if (listed) say(`agent ${id} has no nest's line where what it stands in is listed`);
    }
    // Every listed step stands in its sender's nest, the innermost it is in, or in none, for the main agent's.
    for (const row of rows) {
      if (row.kind !== "exchange") continue;
      const index = indexOf.get(row.key)!;
      const nest = nestsOf(rows, index)[0];
      const own = senderIdOf(stepOf(row.key)!);
      if ((nest === undefined ? undefined : (rows[indexOf.get(nest)!] as Extract<Row, { kind: "nest" }>).agent) !== own) say(`${row.key} is sent as ${own ?? "the main agent"} and stands in ${nest ?? "no nest"}`);
    }

    // A thread's line stands right after the block whose summary the thread on the path begins with, level with it,
    // above the thread's first step.
    const threads = rows.filter(kindOf("thread"));
    const summaryOf = (own: number) => {
      const after = afterOf(own);
      return after?.on === "summary" ? after.key : undefined;
    };
    const carrying = [...path].filter((own) => summaryOf(own) !== undefined);
    if (!sameList(threads.map(({ key }) => key).sort(), carrying.map((own) => `${summaryOf(own)}/thread`).sort())) say("the threads' lines are not those of the threads on the path that carry a summary on");
    for (const thread of threads) {
      found.threads.set(thread.key, `${thread.depth} in`);
      const own = carrying.find((one) => `${summaryOf(one)}/thread` === thread.key);
      if (own === undefined) continue;
      const at = indexOf.get(thread.key)!;
      const block = rows[at - 1];
      if (block?.kind !== "block" || `${block.key}/thread` !== thread.key) {
        say(`${thread.key} does not stand right after its block`);
        continue;
      }
      const { stated } = first(block);
      const summary = stated?.kind === "summary" ? stated.summary : undefined;
      if (summary === undefined || !firstMessage(history, own).includes(summary)) say(`${thread.key} stands after a block whose summary step ${own} does not begin with`);
      if (thread.depth !== block.depth || !block.dimmed) say(`${thread.key} is not level with its block, or its block is not dimmed`);
      if (!(indexOf.get(traceOf(own))! > at) || thread.change === "added" !== (own === step)) say(`${thread.key} does not stand above its thread's first step ${own}, or is ${thread.change}`);
    }
  }
  return { found, broken };
}

const expanded = Object.fromEntries(categories.map((category) => [category, "expanded"])) as Record<Category, Visibility>;

// A recording's events, read line by line, so one of gigabytes is read whole: node holds no string past about 512 MB.
async function eventsOf(recording: string): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [];
  for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) if (line !== "") events.push(JSON.parse(line) as RecordedEvent);
  return events;
}

if (process.argv.length < 3) throw new Error("Give the recordings to check: node packages/ui/check/column.ts <recording.jsonl>...");
let failed = false;
for (const recording of process.argv.slice(2)) {
  const history = createHistory()(createFormatter()(exchanges(await eventsOf(recording))));
  const open = Object.fromEntries([...history.agents.keys()].map((agent) => [nestKey(agent), true]));
  const layOut = createLayout(expanded);
  const { found, broken } = check(history, (step) => layOut(history, step, undefined, open));
  console.log(`${recording}: ${found.steps} steps, ${found.forks.size} forks, ${found.nests.size} nests, ${found.threads.size} threads: ${broken.length === 0 ? "every promise kept" : `${broken.length} broken`}`);
  for (const [key, says] of [...found.forks, ...found.nests, ...found.threads]) console.log(`  ${key}: ${says}`);
  for (const what of broken.slice(0, 40)) console.error(`  ${what}`);
  failed ||= broken.length > 0;
}
process.exitCode = failed ? 1 : 0;
