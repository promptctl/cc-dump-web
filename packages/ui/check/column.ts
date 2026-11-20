import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { exchanges } from "../src/exchanges.ts";
import { categories, type Category } from "../src/format/blocks.ts";
import { createFormatter, type KeyedBlock } from "../src/format/format.ts";
import type { Visibility } from "../src/settings.ts";
import { createHistory, type After, type History } from "../src/view/history.ts";
import { blockOf, createLayout, pastOf, type BlockRow, type Layout, type Row } from "../src/view/rows.ts";

// The column's promises (docs/design/02-design.md, "Two axes"), checked on recordings of real traffic, at every step,
// with every category listed and every nest open: `node packages/ui/check/column.ts <recording.jsonl>...`. It prints
// what each recording holds and each promise a step breaks, and fails if one did.
// [LAW:verifiable-goals] It reads what the history says each step stands after and decides the rest itself, the path,
// each step's level and what a thread carries on from, so it shares the layout's premises and none of its working.

// What a recording holds: its steps, and each fork's, nest's and thread's line the column lists at some step, by its
// key, with what it says where it says the most.
type Found = { steps: number; forks: Map<string, string>; nests: Map<string, string>; threads: Map<string, string> };

// The block an item arrived as, which says what it launches or sums up.
const first = ({ versions }: Pick<BlockRow, "versions">): KeyedBlock => {
  const version = versions[0]!;
  return version.block === undefined ? version.was : version.block;
};
// A field a block prints by name, as a call prints its id and a result the id of its call: the last so named, since
// what a tool's input holds is printed before it.
const fieldOf = ({ parts }: KeyedBlock, name: string): string | undefined =>
  parts
    .flatMap((part) => (part.kind === "fields" ? part.fields : []))
    .findLast(([field, value]) => field === name && typeof value === "string")?.[1] as string | undefined;
const textsOf = ({ parts }: KeyedBlock): string[] => parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
// What a step's first message says: its texts, less those the harness injected.
const firstMessage = ({ segments }: History, step: number): string =>
  (segments[step - 1]!.formatted.groups.find(({ key }) => key === "message.0")?.blocks ?? []).flatMap((block) => (block.injected === undefined ? textsOf(block) : [])).join("");
// What Claude Code's Agent call's result says of the subagent it launched, and what it tells its main agent as one
// stops, each notification once (seen on its traffic, 2026-11-18).
const launched = /^Async agent launched successfully[\s\S]*?\nagentId: ([0-9a-z]+)/;
const notifying = /<task-notification>(?:(?!<\/task-notification>)[\s\S])*?<task-id>([^<]+)<\/task-id>[\s\S]*?<\/task-notification>/g;
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((one, index) => one === b[index]);
const kindOf =
  <Kind extends Row["kind"]>(kind: Kind) =>
  (row: Row): row is Extract<Row, { kind: Kind }> =>
    row.kind === kind;

function check(history: History, layoutAt: (step: number) => Layout): { found: Found; broken: string[] } {
  const { segments, stepOf } = history;
  const afterOf = (step: number): After | undefined => segments[step - 1]!.after;
  const traceOf = (step: number) => segments[step - 1]!.formatted.exchange.trace_id;
  // What each step stands after, by name, and the steps of the recording that stand after each thing: siblings.
  const places = segments.map(({ after }) => (after === undefined ? undefined : after.on === "step" ? traceOf(after.step) : after.key));
  const siblings = new Map<string, number[]>();
  places.forEach((place, index) => place !== undefined && siblings.set(place, [...(siblings.get(place) ?? []), index + 1]));
  // A step's level: the nest it is in, by the nest's line, or none; and the step whose call each nest hangs on.
  const hangs = (after: After | undefined, as: "nest" | "thread"): after is Extract<After, { on: "block" }> => after?.on === "block" && after.as === as;
  const levelOf = (step: number): string | undefined => {
    const after = afterOf(step);
    return after === undefined ? undefined : hangs(after, "nest") ? `${after.key}/nest` : levelOf(after.step);
  };
  const callers = new Map<string, number>(segments.flatMap(({ after }) => (hangs(after, "nest") ? [[`${after.key}/nest`, after.step] as const] : [])));
  const depthOf = (step: number): number => {
    const level = levelOf(step);
    return level === undefined ? 0 : 1 + depthOf(callers.get(level)!);
  };
  // The agent a step is sent as, by the id its request's head says: none for the main thread's.
  const agentOf = (step: number) => segments[step - 1]!.formatted.exchange.request.head?.headers.find(([name]) => name.toLowerCase() === "x-claude-code-agent-id")?.[1];
  const blocksAt = (step: number) => segments[step - 1]!.formatted.groups.flatMap(({ blocks }) => blocks);
  // The agent an Agent call's result names, by the call's id, at the first step whose request sends it.
  const named = new Map<string, { agent: string; step: number }>();
  // The steps at which the caller of each agent is first told it stopped, by the notification's text.
  const told = new Map<string, number[]>();
  const notified = new Set<string>();
  segments.forEach((_, index) => {
    for (const block of blocksAt(index + 1)) {
      const call = fieldOf(block, "tool_use_id");
      const agent = textsOf(block).map((text) => launched.exec(text)?.[1]).find((one) => one !== undefined);
      if (call !== undefined && agent !== undefined && !named.has(call)) named.set(call, { agent, step: index + 1 });
      for (const text of textsOf(block))
        for (const [notification, agent] of text.matchAll(notifying)) {
          if (notified.has(notification)) continue;
          notified.add(notification);
          told.set(agent!, [...(told.get(agent!) ?? []), index + 1]);
        }
    }
  });

  const found: Found = { steps: segments.length, forks: new Map(), nests: new Map(), threads: new Map() };
  const broken: string[] = [];
  for (let step = 1; step <= segments.length; step++) {
    const say = (what: string) => broken.push(`step ${step}: ${what}`);
    const arrived = Array.from({ length: step }, (_, index) => index + 1);
    // The path to the step: a step that stands after nothing, and, of the siblings that have arrived after a thing on
    // it, the one the latest step by now stands under.
    const latest = new Array<number>(step + 1).fill(0);
    for (let own = 1; own <= step; own++) for (let up: number | undefined = own; up !== undefined; up = afterOf(up)?.step) latest[up] = own;
    const path = new Set<number>();
    for (let own = 1; own <= step; own++) {
      const after = afterOf(own);
      if (after === undefined || (path.has(after.step) && siblings.get(places[own - 1]!)!.every((other) => other > step || latest[other]! <= latest[own]!))) path.add(own);
    }
    // What a thread on the path carries on from: the step whose summary it begins with, and each that one follows
    // or carries on. A step is dimmed when it is one, or the call its nest hangs on is in one.
    const carried = new Set<number>();
    for (const own of path) {
      const after = afterOf(own);
      for (let on = hangs(after, "thread") ? after.step : undefined; on !== undefined; ) {
        carried.add(on);
        const up = afterOf(on);
        on = up === undefined || hangs(up, "nest") ? undefined : up.step;
      }
    }
    const isDimmed = (own: number): boolean => carried.has(own) || (levelOf(own) !== undefined && isDimmed(callers.get(levelOf(own)!)!));

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
        // First under the line of what hangs there: one level in under a nest's, level with a thread's.
        const line = rows[at - 1];
        if (line?.key !== `${after.key}/${after.as}` || fork.depth !== line.depth + (after.as === "nest" ? 1 : 0)) say(`${fork.key} is not first under the ${after.as}'s line`);
      }
    }

    // A nest's line stands right after the Agent call whose prompt its first step's first message says, and holds its
    // level's steps on the path one level in, in the order they arrived, before the call's result.
    const nests = rows.filter(kindOf("nest"));
    const nested = [...path].filter((own) => hangs(afterOf(own), "nest"));
    if (!sameList(nests.map(({ key }) => key).sort(), nested.map((own) => levelOf(own)!).sort())) say("the nests' lines are not those of the subagents on the path");
    for (const nest of nests) {
      found.nests.set(nest.key, `${nest.depth} in, ${nest.type ?? "an agent"}, ${nest.count} steps`);
      const root = nested.find((own) => levelOf(own) === nest.key);
      if (root === undefined) continue;
      const at = indexOf.get(nest.key)!;
      const call = rows[at - 1];
      if (call?.kind !== "block" || `${call.key}/nest` !== nest.key) {
        say(`${nest.key} does not stand right after its call`);
        continue;
      }
      const { launch } = first(call);
      if (launch === undefined) say(`${nest.key} stands after a block that launches nothing`);
      else if (firstMessage(history, root).trim() !== launch.prompt.trim()) say(`${nest.key} holds step ${root}, whose first message is not its call's prompt`);
      else if (nest.prompt !== launch.prompt || nest.type !== launch.type) say(`${nest.key} does not say what its call launches`);
      if (nest.depth !== call.depth || nest.dimmed !== call.dimmed) say(`${nest.key} does not stand as its call does`);
      const next = rows.findIndex((row, index) => index > at && row.depth <= nest.depth);
      const end = next === -1 ? rows.length : next;
      const inside = rows.slice(at + 1, end).filter((row) => row.kind === "exchange" && row.depth === nest.depth + 1).map(({ key }) => stepOf(key));
      const level = [...path].filter((own) => levelOf(own) === nest.key);
      if (!sameList(inside, level)) say(`${nest.key} holds steps ${inside.join(" ")} where its level's on the path are ${level.join(" ")}`);
      if (nest.count !== level.length) say(`${nest.key} counts ${nest.count} steps of ${level.length}`);
      // Its subagent is the agent its first step is sent under, which the call's result names once it has arrived, and
      // every step sent under that agent by now is one of its level. Its line says the last thing the subagent did
      // while it runs: from a reply of the agent's with a block until one that calls SubagentHandback or its caller is
      // told it stopped, whichever was last.
      const id = fieldOf(first(call), "id");
      const agent = agentOf(root);
      const naming = id === undefined ? undefined : named.get(id);
      if (agent === undefined) say(`${nest.key}'s first step ${root} is sent under no agent's id, so whom it holds is not checked`);
      else {
        if (naming !== undefined && naming.step <= step && naming.agent !== agent) say(`${nest.key} holds agent ${agent} where its call's result names ${naming.agent}`);
        const sent = arrived.filter((own) => agentOf(own) === agent);
        if (sent.some((own) => levelOf(own) !== nest.key)) say(`${nest.key} does not hold every step sent under agent ${agent}`);
        const replies = sent.flatMap((own) => {
          const reply = blocksAt(own).filter(({ place }) => place?.in === "reply");
          return reply.length === 0 ? [] : [{ step: own, last: reply.at(-1)!, handsBack: reply.some(({ name }) => name === "tool_use: SubagentHandback") }];
        });
        const newest = replies.at(-1);
        const stopped = Math.max(0, ...replies.filter(({ handsBack }) => handsBack).map(({ step }) => step), ...(told.get(agent) ?? []).filter((own) => own <= step));
        const runs = newest !== undefined && newest.step > stopped;
        if (nest.latest !== (runs ? newest.last : undefined)) say(`${nest.key} says ${nest.latest?.name ?? "nothing"} where its subagent ${runs ? `last did ${newest.last.name} at` : "is stopped by"} its step ${runs ? newest.step : stopped}`);
      }
      rows.forEach((row, index) => {
        if (row.kind !== "block" || id === undefined || fieldOf(blockOf(row), "tool_use_id") !== id) return;
        if (index < end || row.depth !== call.depth) say(`${nest.key} does not stand between its call and the call's result ${row.key}, at their depth`);
      });
    }

    // A thread's line stands right after the block whose summary the thread on the path begins with, level with it,
    // above the thread's first step.
    const threads = rows.filter(kindOf("thread"));
    const carrying = [...path].filter((own) => hangs(afterOf(own), "thread"));
    if (!sameList(threads.map(({ key }) => key).sort(), carrying.map((own) => `${(afterOf(own) as Extract<After, { on: "block" }>).key}/thread`).sort())) say("the threads' lines are not those of the threads on the path that carry a summary on");
    for (const thread of threads) {
      found.threads.set(thread.key, `${thread.depth} in`);
      const own = carrying.find((one) => `${(afterOf(one) as Extract<After, { on: "block" }>).key}/thread` === thread.key);
      if (own === undefined) continue;
      const at = indexOf.get(thread.key)!;
      const block = rows[at - 1];
      if (block?.kind !== "block" || `${block.key}/thread` !== thread.key) {
        say(`${thread.key} does not stand right after its block`);
        continue;
      }
      const { summary } = first(block);
      if (summary === undefined || !firstMessage(history, own).includes(summary)) say(`${thread.key} stands after a block whose summary step ${own} does not begin with`);
      if (thread.depth !== block.depth || !block.dimmed) say(`${thread.key} is not level with its block, or its block is not dimmed`);
      if (!(indexOf.get(traceOf(own))! > at) || thread.change === "added" !== (own === step)) say(`${thread.key} does not stand above its thread's first step ${own}, or is ${thread.change}`);
    }
  }
  return { found, broken };
}

const expanded = Object.fromEntries(categories.map((category) => [category, "expanded"])) as Record<Category, Visibility>;
let failed = false;
for (const recording of process.argv.slice(2)) {
  // Line by line, as a recording of gigabytes is longer than a string may be.
  const events: RecordedEvent[] = [];
  for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) if (line !== "") events.push(JSON.parse(line) as RecordedEvent);
  const history = createHistory()(createFormatter()(exchanges(events)));
  const open = Object.fromEntries(history.segments.flatMap(({ after }) => (after?.on === "block" && after.as === "nest" ? [[`${after.key}/nest`, true] as const] : [])));
  const layOut = createLayout(expanded);
  const { found, broken } = check(history, (step) => layOut(history, step, undefined, open));
  console.log(`${recording}: ${found.steps} steps, ${found.forks.size} forks, ${found.nests.size} nests, ${found.threads.size} threads: ${broken.length === 0 ? "every promise kept" : `${broken.length} broken`}`);
  for (const [key, says] of [...found.forks, ...found.nests, ...found.threads]) console.log(`  ${key}: ${says}`);
  for (const what of broken.slice(0, 40)) console.error(`  ${what}`);
  failed ||= broken.length > 0;
}
if (process.argv.length < 3) throw new Error("Give the recordings to check: node packages/ui/check/column.ts <recording.jsonl>...");
process.exitCode = failed ? 1 : 0;
