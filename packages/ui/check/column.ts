import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Header, RecordedEvent } from "@cc-dump/proxy/format";
import { exchanges, type Exchange } from "../src/exchanges.ts";
import { categories, type Category } from "../src/format/blocks.ts";
import { createDecoding } from "../src/format/body.ts";
import { createFormatter, type KeyedBlock } from "../src/format/format.ts";
import type { Visibility } from "../src/settings.ts";
import { agentLevel, createHistory, top, type After, type History, type Placement } from "../src/view/history.ts";
import { blockOf, createLayout, pastOf, type BlockRow, type Layout, type Row } from "../src/view/rows.ts";

// The column's promises (docs/design/02-design.md, "Two axes"), checked on recordings of real traffic, at every step,
// with every category listed and every nest open: `node packages/ui/check/column.ts <recording.jsonl>...`. It prints
// what each recording holds and each promise a step breaks, and fails if one did.
// [LAW:verifiable-goals] It reads what the history says each step stands after and decides the rest itself, the path
// and what a thread carries on from, so it shares the layout's premises and none of its working. Who sent each step,
// which call each subagent stands under and when it stops it reads from the wire alone (docs/design/claude-code-wire.md),
// never from what the formatter says of a block: its agent headers, the agent each call's result names, the
// notifications in the harness's text, and which calls each request answers and each reply makes.

// What the wire says of one exchange. `sender`: its agent headers, none where its head was not recorded. Of its
// request's messages: the tasks `told` stopped in the harness's text, the agents `named` by a tool's
// result, and the calls a result `answers`. Of its reply: the `calls` it makes, why it `stopped`, its `last` block's
// name and whether that hands a report back, and whether the exchange `ended`. `undecoded`: a side whose body did not
// decode, which says nothing.
type Wire = {
  sender: { agent: string | undefined; parent: string | undefined } | undefined;
  told: string[];
  named: { call: string; agent: string; ran: "background" | "foreground" }[];
  answers: Set<string>;
  calls: Set<string>;
  stopped: string | undefined;
  last: string | undefined;
  handback: boolean;
  ended: boolean;
  undecoded: string[];
};

const valueOf = (headers: Header[], name: string) => headers.find(([field]) => field.toLowerCase() === name)?.[1];
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const texts = (content: unknown): string[] => (typeof content === "string" ? [content] : list(content).map((block) => field(block, "text"))).filter((text): text is string => typeof text === "string");

// The wire of one exchange, its bodies decoded as their content codings say.
function wireOf({ request, response, end }: Exchange): Wire {
  const headers = request.head?.headers;
  const wire: Wire = {
    sender: headers === undefined ? undefined : { agent: valueOf(headers, "x-claude-code-agent-id"), parent: valueOf(headers, "x-claude-code-parent-agent-id") },
    told: [],
    named: [],
    answers: new Set(),
    calls: new Set(),
    stopped: undefined,
    last: undefined,
    handback: false,
    ended: end !== undefined,
    undecoded: [],
  };
  const sides = { request, response };
  // A request is read once its body is whole: one its client stopped sending part way says no more than its head, as
  // the API never had it. A reply is read as far as it has come.
  const read = (name: keyof typeof sides, then: (text: string) => void) => {
    const side = sides[name];
    if (side.head === undefined || side.body.length === 0 || (name === "request" && side.completedBy?.type !== "request_trailers")) return;
    const { text, error } = createDecoding(side.head.headers).decode(side.body, side.completedBy !== undefined);
    try {
      if (error !== undefined) throw new Error(error);
      then(text);
    } catch (error) {
      wire.undecoded.push(`${name}: ${(error as Error).message}`);
    }
  };
  read("request", (text) => {
    for (const message of list(field(JSON.parse(text), "messages"))) {
      const content = field(message, "content");
      for (const block of typeof content === "string" ? [{ type: "text", text: content }] : list(content)) {
        const text = field(block, "text");
        // The harness's text: a system-role message's whole, and each system reminder of another's.
        const harness = typeof text !== "string" ? [] : field(message, "role") === "system" ? [text] : [...text.matchAll(/^<system-reminder>[\s\S]*?^<\/system-reminder>/gm)].map(([reminder]) => reminder);
        for (const [, inner] of harness.flatMap((one) => [...one.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)])) {
          const task = /<task-id>([^<]+)<\/task-id>/.exec(inner!)?.[1];
          if (task !== undefined) wire.told.push(task);
        }
        const call = field(block, "tool_use_id");
        if (field(block, "type") !== "tool_result" || typeof call !== "string") continue;
        wire.answers.add(call);
        // Claude Code's frame of an Agent call's result: a background launch's one text, or a foreground run's last.
        const said = texts(field(block, "content"));
        const background = /^Async agent launched successfully\.[^\n]*\nagentId: (\S+)/.exec(said[0] ?? "")?.[1];
        const foreground = said.length > 1 ? /^agentId: (\S+)[\s\S]*\n<usage>[\s\S]*<\/usage>$/.exec(said.at(-1)!)?.[1] : undefined;
        if (background !== undefined) wire.named.push({ call, agent: background, ran: "background" });
        else if (foreground !== undefined) wire.named.push({ call, agent: foreground, ran: "foreground" });
      }
    }
  });
  read("response", (text) => {
    // A stream's blocks by their index, and its stop; or a message's.
    const streamed = (valueOf(response.head!.headers, "content-type") ?? "").startsWith("text/event-stream");
    // A stream's lines, less what follows its last line break, a line not yet whole.
    const events = streamed ? text.split("\n").slice(0, -1).flatMap((line) => (line.startsWith("data: ") ? [JSON.parse(line.slice(6)) as unknown] : [])) : [];
    const message = streamed ? undefined : JSON.parse(text);
    const blocks = streamed ? events.flatMap((event) => (field(event, "type") === "content_block_start" ? [field(event, "content_block")] : [])) : list(field(message, "content"));
    wire.stopped = (streamed ? events.map((event) => field(field(event, "delta"), "stop_reason")).findLast((reason) => typeof reason === "string") : field(message, "stop_reason")) as string | undefined;
    for (const block of blocks) if (field(block, "type") === "tool_use") wire.calls.add(field(block, "id") as string);
    const last = blocks.at(-1);
    const type = field(last, "type");
    wire.last = typeof type !== "string" ? undefined : type.endsWith("tool_use") ? `${type}: ${field(last, "name") as string}` : type;
    wire.handback = field(last, "name") === "SubagentHandback";
  });
  return wire;
}

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
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((one, index) => one === b[index]);
const kindOf =
  <Kind extends Row["kind"]>(kind: Kind) =>
  (row: Row): row is Extract<Row, { kind: Kind }> =>
    row.kind === kind;

function check(history: History, wires: readonly Wire[], layoutAt: (step: number) => Layout): { found: Found; broken: string[] } {
  const { segments, stepOf, placements } = history;
  const wireAt = (step: number) => wires[step - 1]!;
  const afterOf = (step: number): After | undefined => segments[step - 1]!.after;
  const traceOf = (step: number) => segments[step - 1]!.formatted.exchange.trace_id;
  // What each step stands after, by name, and the steps of the recording that stand after each thing: siblings.
  const places = segments.map(({ after }) => (after === undefined ? undefined : after.on === "step" ? traceOf(after.step) : after.key));
  const siblings = new Map<string, number[]>();
  places.forEach((place, index) => place !== undefined && siblings.set(place, [...(siblings.get(place) ?? []), index + 1]));
  // A step's level, by its nest's line, none for the main agent's; how far in a level stands, and whether it is
  // dimmed, as the call it stands under is, or the level it stands at the end of.
  const carries = (after: After | undefined): after is Extract<After, { on: "summary" }> => after?.on === "summary";
  const nestOf = (level: string) => {
    const placement = placements.get(level)!;
    return `${placement.on === "call" ? placement.key : level}/nest`;
  };
  const levelOf = (step: number): string | undefined => (segments[step - 1]!.level === top ? undefined : nestOf(segments[step - 1]!.level));
  const outward = <T>(level: string, atTop: T, atCall: (step: number) => T, atLevel: (level: string) => T): T => {
    if (level === top) return atTop;
    const placement = placements.get(level)!;
    return placement.on === "call" ? atCall(placement.step) : atLevel(placement.level);
  };
  const levelDepth = (level: string): number => outward(level, 0, (call) => 1 + depthOf(call), (parent) => 1 + levelDepth(parent));
  const depthOf = (step: number): number => levelDepth(segments[step - 1]!.level);
  // Whether a level is listed once its steps are on the path: where its call's step is, or the level it stands in.
  const levelListed = (level: string, path: Set<number>): boolean => outward(level, true, (call) => path.has(call), (parent) => levelListed(parent, path));
  // The step a step stands under: the one it stands after, or the step of the call its level stands under.
  const underOf = (step: number): number | undefined => afterOf(step)?.step ?? outward(segments[step - 1]!.level, undefined, (call) => call, () => undefined);
  // The agent a step is sent as, by the id its request says: none for the main agent's.
  const agentOf = (step: number) => wireAt(step).sender?.agent;
  const steps = Array.from({ length: segments.length }, (_, index) => index + 1);

  // What the wire says of every step whatever the column lists: its level is its sender's, and each subagent's level
  // stands under the call the first result naming its agent names, from the step that first made the call, or else at
  // the end of the level of the agent its first request says launched it.
  const broken: string[] = [];
  for (const step of steps) {
    const { sender, undecoded } = wireAt(step);
    for (const side of undecoded) broken.push(`step ${step}: its ${side} does not decode, so the wire says nothing of it`);
    const level = sender === undefined ? `unrecorded:${traceOf(step)}` : sender.agent === undefined ? top : agentLevel(sender.agent);
    if (segments[step - 1]!.level !== level) broken.push(`step ${step}: stands on level ${segments[step - 1]!.level} where its sender's is ${level}`);
  }
  const agents = [...new Set(steps.flatMap((step) => (agentOf(step) === undefined ? [] : [agentOf(step)!])))];
  for (const agent of agents) {
    const named = steps.flatMap((step) => wireAt(step).named).find((one) => one.agent === agent);
    const callStep = named === undefined ? undefined : steps.find((step) => wireAt(step).calls.has(named.call));
    const parent = wireAt(steps.find((step) => agentOf(step) === agent)!).sender!.parent;
    const placement = placements.get(agentLevel(agent));
    const expected: Placement | undefined =
      callStep !== undefined ? (placement?.on === "call" ? { ...placement, step: callStep } : undefined) : { on: "level", level: parent === undefined ? top : agentLevel(parent) };
    if (placement === undefined || expected === undefined || JSON.stringify(placement) !== JSON.stringify(expected)) broken.push(`agent ${agent} stands ${JSON.stringify(placement)} where the wire says ${callStep === undefined ? JSON.stringify(expected) : `under ${named!.call}, made at step ${callStep}`}`);
  }

  const found: Found = { steps: segments.length, forks: new Map(), nests: new Map(), threads: new Map() };
  for (let step = 1; step <= segments.length; step++) {
    const say = (what: string) => broken.push(`step ${step}: ${what}`);
    const arrived = Array.from({ length: step }, (_, index) => index + 1);
    // The path to the step: a step that stands after nothing, and, of the siblings that have arrived after a thing on
    // it, the one the latest step by now stands under.
    const latest = new Array<number>(step + 1).fill(0);
    for (let own = 1; own <= step; own++) for (let up: number | undefined = own; up !== undefined; up = underOf(up)) latest[up] = own;
    const path = new Set<number>();
    for (let own = 1; own <= step; own++) {
      const after = afterOf(own);
      if (after === undefined ? levelListed(segments[own - 1]!.level, path) : path.has(after.step) && siblings.get(places[own - 1]!)!.every((other) => other > step || latest[other]! <= latest[own]!)) path.add(own);
    }
    // What a thread on the path carries on from: the step whose summary it begins with, and each that one follows
    // or carries on. A step is dimmed when it is one, or the call its nest hangs on is in one.
    const carried = new Set<number>();
    for (const own of path) {
      const after = afterOf(own);
      for (let on = carries(after) ? after.step : undefined; on !== undefined; on = afterOf(on)?.step) carried.add(on);
    }
    const levelDimmed = (level: string): boolean => outward(level, false, (call) => isDimmed(call), levelDimmed);
    const isDimmed = (own: number): boolean => carried.has(own) || levelDimmed(segments[own - 1]!.level);

    const { rows, every, steps: shown } = layoutAt(step);
    const indexOf = new Map(rows.map(({ key }, index) => [key, index]));
    if (rows.length !== every.rows.length) say(`${every.rows.length - rows.length} rows are not listed with every category listed and every nest open`);
    if (indexOf.size !== rows.length) say("two rows have one key");

    // The column lists the path, one step after each thing, each step's line once.
    const listed = [...shown].sort((a, b) => a - b);
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
        // First under the line of the thread that carries the summary on, level with it.
        const line = rows[at - 1];
        if (line?.key !== `${after.key}/thread` || fork.depth !== line.depth) say(`${fork.key} is not first under the thread's line`);
      }
    }

    // A nest's line stands right after the Agent call whose result names the agent its steps are sent by, and holds its
    // level's steps on the path one level in, in the order they arrived, before the call's result.
    const nests = rows.filter(kindOf("nest"));
    const nested = [...new Set([...path].flatMap((own) => (levelOf(own) === undefined ? [] : [levelOf(own)!])))];
    if (!sameList(nests.map(({ key }) => key).sort(), nested.sort())) say("the nests' lines are not those of the subagents on the path");
    for (const nest of nests) {
      found.nests.set(nest.key, `${nest.depth} in, ${nest.subagent.on === "call" ? (nest.subagent.type ?? "an agent") : `${nest.subagent.agent ?? "no agent"}, not yet placed`}, ${nest.count} steps`);
      const root = [...path].find((own) => levelOf(own) === nest.key);
      if (root === undefined) continue;
      const at = indexOf.get(nest.key)!;
      // Its line says the last thing the subagent did while it runs, which is decided here from the wire: of the
      // replies to its agent's requests by now, sent after the last stop that names the agent, the newest with a block
      // that is still coming, or stopped for a tool no request of the agent's has since answered, unless the block hands
      // the report back. A request answers once its own reply has a block or its exchange has ended.
      const agent = agentOf(root);
      if (agent === undefined) say(`${nest.key}'s first step ${root} is sent under no agent's id, so whether it runs is not checked`);
      else {
        const stops = arrived.filter((own) => wireAt(own).told.includes(agent) || wireAt(own).named.some((one) => one.agent === agent && one.ran === "foreground"));
        // A reply waits on every call it makes, each answered by a later request of the agent's sending its result.
        const answers = (later: number, own: number, call: string) => later > own && agentOf(later) === agent && (wireAt(later).ended || wireAt(later).last !== undefined) && wireAt(later).answers.has(call);
        const answered = (own: number) => [...wireAt(own).calls].every((call) => arrived.some((later) => answers(later, own, call)));
        const waits = (own: number) => {
          const { ended, stopped, handback, last } = wireAt(own);
          return last !== undefined && (!ended || (stopped === "tool_use" && !handback && !answered(own)));
        };
        const newest = arrived.findLast((own) => agentOf(own) === agent && own > (stops.at(-1) ?? 0) && waits(own));
        const says = newest === undefined ? undefined : wireAt(newest).last;
        if (nest.latest?.name !== says) say(`${nest.key} says ${nest.latest?.name ?? "nothing"} where its subagent ${says === undefined ? "does not run" : `last did ${says} at its step ${newest}`}`);
      }
      if (nest.subagent.on === "level") continue;
      const call = rows[at - 1];
      if (call?.kind !== "block" || `${call.key}/nest` !== nest.key) {
        say(`${nest.key} does not stand right after its call`);
        continue;
      }
      const { launch } = first(call);
      if (launch === undefined) say(`${nest.key} stands after a block that launches nothing`);
      else if (nest.subagent.prompt !== launch.prompt || nest.subagent.type !== launch.type) say(`${nest.key} does not say what its call launches`);
      if (nest.depth !== call.depth || nest.dimmed !== call.dimmed) say(`${nest.key} does not stand as its call does`);
      const next = rows.findIndex((row, index) => index > at && row.depth <= nest.depth);
      const end = next === -1 ? rows.length : next;
      const inside = rows.slice(at + 1, end).filter((row) => row.kind === "exchange" && row.depth === nest.depth + 1).map(({ key }) => stepOf(key));
      const level = [...path].filter((own) => levelOf(own) === nest.key);
      if (!sameList(inside, level)) say(`${nest.key} holds steps ${inside.join(" ")} where its level's on the path are ${level.join(" ")}`);
      if (nest.count !== level.length) say(`${nest.key} counts ${nest.count} steps of ${level.length}`);
      // Of the results of the call, its level's: a fork of the thread, a level of its own, resends one of its own.
      const id = fieldOf(first(call), "id");
      const levelAt = (own: number) => segments[own - 1]!.level;
      rows.forEach((row, index) => {
        if (row.kind !== "block" || id === undefined || fieldOf(blockOf(row), "tool_use_id") !== id || levelAt(row.versions[0]!.step) !== levelAt(call.versions[0]!.step)) return;
        if (index < end || row.depth !== call.depth) say(`${nest.key} does not stand between its call and the call's result ${row.key}, at their depth`);
      });
    }

    // A thread's line stands right after the block whose summary the thread on the path begins with, level with it,
    // above the thread's first step.
    const threads = rows.filter(kindOf("thread"));
    const carrying = [...path].filter((own) => carries(afterOf(own)));
    const summaryOf = (own: number) => (afterOf(own) as Extract<After, { on: "summary" }>).key;
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
  // Line by line, so a recording larger than a string can be is read.
  const events: RecordedEvent[] = [];
  for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) if (line !== "") events.push(JSON.parse(line) as RecordedEvent);
  const history = createHistory()(createFormatter()(exchanges(events)));
  const wires = history.segments.map(({ formatted }) => wireOf(formatted.exchange));
  const open = Object.fromEntries([...history.placements].map(([level, placement]) => [`${placement.on === "call" ? placement.key : level}/nest`, true] as const));
  const layOut = createLayout(expanded);
  const { found, broken } = check(history, wires, (step) => layOut(history, step, undefined, open));
  console.log(`${recording}: ${found.steps} steps, ${found.forks.size} forks, ${found.nests.size} nests, ${found.threads.size} threads: ${broken.length === 0 ? "every promise kept" : `${broken.length} broken`}`);
  for (const [key, says] of [...found.forks, ...found.nests, ...found.threads]) console.log(`  ${key}: ${says}`);
  for (const what of broken.slice(0, 40)) console.error(`  ${what}`);
  failed ||= broken.length > 0;
}
if (process.argv.length < 3) throw new Error("Give the recordings to check: node packages/ui/check/column.ts <recording.jsonl>...");
process.exitCode = failed ? 1 : 0;
