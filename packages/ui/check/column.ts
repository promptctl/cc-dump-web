import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { exchanges, type Exchange } from "../src/exchanges.ts";
import { categories, type Category } from "../src/format/blocks.ts";
import { createFormatter, type FormattedExchange, type KeyedBlock } from "../src/format/format.ts";
import type { Visibility } from "../src/settings.ts";
import { createHistory } from "../src/view/history.ts";
import { createLayout, type NestRow, type Row } from "../src/view/rows.ts";

// Where each subagent stands, and whether it runs, checked on recordings of real traffic at every step, with every
// category listed and every nest open: `node packages/ui/check/column.ts <recording.jsonl>...`. It prints what each
// recording holds and each promise a step breaks, and fails if one did.
// [LAW:verifiable-goals] Each promise is decided from what the wire says (format/wire.ts, read through what the
// formatter states of each exchange and block) against the rows the layout returns, and nothing of the layout's
// working: who sent each step, the call each nest's agent is tied to by then, the stops told by then, and the replies
// that wait.

// What the wire says of a recording's steps, in the order they arrived.
type Step = {
  sender: FormattedExchange["sender"];
  // The calls its reply makes, the ids of the calls its request's results answer, the agents those results name with
  // the calls they answer, and the notifications it sends: the agents each tells stopped, with the call where named,
  // and its text, which a request that resends it sends again.
  calls: { id: string; waits: boolean }[];
  answers: string[];
  named: { agent: string; call: string }[];
  notices: { text: string; told: { agent: string; call: string | undefined }[] }[];
  stopReason: string | undefined;
  last: KeyedBlock | undefined;
  ended: number | undefined;
};

const blocksIn = (formatted: FormattedExchange, group: (key: string) => boolean) => formatted.groups.filter(({ key }) => group(key)).flatMap(({ blocks }) => blocks);
function stepOf(formatted: FormattedExchange): Step {
  const reply = blocksIn(formatted, (key) => key === "reply").filter(({ place }) => place?.in === "reply");
  const sent = blocksIn(formatted, (key) => key.startsWith("message."));
  const calls = new Map(sent.flatMap(({ stated }) => (stated?.kind === "call" ? [[stated.id, stated.tool.kind] as const] : [])));
  return {
    sender: formatted.sender,
    calls: reply.flatMap(({ stated }) => (stated?.kind === "call" ? [{ id: stated.id, waits: stated.tool.kind !== "handback" }] : [])),
    answers: sent.flatMap(({ stated }) => (stated?.kind === "result" ? [stated.answers] : [])),
    named: sent.flatMap(({ stated }) => (stated?.kind === "result" && stated.names !== undefined && launching(calls.get(stated.answers)) ? [{ agent: stated.names, call: stated.answers }] : [])),
    notices: sent.flatMap(({ stated, parts }) => (stated?.kind === "notification" ? [{ text: JSON.stringify(parts), told: stated.told }] : [])),
    stopReason: formatted.facts.stopReason,
    last: reply.at(-1),
    ended: formatted.exchange.end === undefined ? undefined : Date.parse(formatted.exchange.end.timestamp),
  };
}
const launching = (tool: string | undefined) => tool === "agent" || tool === "skill";

// What the wire says of each subagent through a recording: its steps; the steps that first send a notification telling
// it stopped, each with the call it names; and those that tell it by the result of its call.
type Told = { at: number; agent: string; call: string | undefined };
type Agents = { own: Map<string, number[]>; stops: Map<string, number[]>; told: Told[] };
function agentsOf(steps: readonly Step[]): Agents {
  const own = new Map<string, number[]>();
  const stops = new Map<string, number[]>();
  const told: Told[] = [];
  const sent = new Set<string>();
  steps.forEach(({ sender, notices }, index) => {
    if (sender.kind === "subagent") own.set(sender.id, [...(own.get(sender.id) ?? []), index + 1]);
    for (const { text, told: stopped } of notices) {
      if (sent.has(text)) continue;
      sent.add(text);
      for (const { agent, call } of stopped) {
        stops.set(agent, [...(stops.get(agent) ?? []), index + 1]);
        told.push({ at: index + 1, agent, call });
      }
    }
  });
  return { own, stops, told };
}

// Of each subagent at step `step`, from the steps up to it: its parent, by its first step's header, where that agent
// sent a step before it; the call it is tied to, by the latest result or notification on its parent's level by then
// that names it with its call; and whether it runs, with the last block of the newest reply of its turn.
type Wire = { parent: string | undefined; unrecorded: string | undefined; call: string | undefined; runs: boolean; latest: KeyedBlock | undefined };
function wireAt(steps: readonly Step[], { own, stops, told }: Agents, step: number): Map<string, Wire> {
  const moment = steps[step - 1]!.ended ?? Infinity;
  const agents = new Map<string, Wire>();
  for (const [id, all] of own) {
    if (all[0]! > step) continue;
    const { sender } = steps[all[0]! - 1]!;
    const parent = sender.kind === "subagent" ? sender.parent : undefined;
    const earlier = parent !== undefined && (own.get(parent)?.[0] ?? Infinity) < all[0]!;
    agents.set(id, { parent: earlier ? parent : undefined, unrecorded: earlier ? undefined : parent, call: undefined, runs: false, latest: undefined });
  }
  const levelOf = ({ sender }: Step) => (sender.kind === "subagent" ? sender.id : undefined);
  const ties = steps.slice(0, step).flatMap((one, index) => [...one.named.map((tie) => ({ ...tie, at: index + 1 })), ...told.filter(({ at, call }) => at === index + 1 && call !== undefined)]);
  for (const { agent, call, at } of ties) {
    const wire = agents.get(agent);
    if (wire !== undefined && wire.parent === levelOf(steps[at - 1]!)) wire.call = call;
  }
  for (const [id, wire] of agents) {
    const mine = own.get(id)!.filter((at) => at <= step);
    const answered = new Set(mine.flatMap((at) => steps[at - 1]!.answers));
    const stopped = (stops.get(id) ?? []).filter((at) => at <= step);
    for (const at of mine) {
      const { ended, stopReason, calls, last } = steps[at - 1]!;
      const coming = ended === undefined || ended > moment;
      const waits = stopReason === "tool_use" && calls.some(({ id, waits }) => waits && !answered.has(id));
      if ((coming || waits) && !stopped.some((stop) => stop > at)) wire.runs = true;
      const handback = last?.stated?.kind === "call" && last.stated.tool.kind === "handback";
      if ((coming || stopReason === "tool_use") && last !== undefined && !handback) wire.latest = last;
    }
    if (!wire.runs) wire.latest = undefined;
  }
  return agents;
}

type Found = { steps: number; unchecked: number; agents: Set<string>; tied: Set<string>; running: Set<string> };

function check(steps: readonly Step[], layoutAt: (step: number) => { rows: Row[]; every: { rows: Row[] }; steps: ReadonlySet<number> }, found: Found): string[] {
  const broken: string[] = [];
  const agents = agentsOf(steps);
  for (let step = 1; step <= steps.length; step++) {
    const say = (what: string) => broken.push(`step ${step}: ${what}`);
    const wire = wireAt(steps, agents, step);
    const { rows, every, steps: listed } = layoutAt(step);
    if (rows.length !== every.rows.length) say(`${every.rows.length - rows.length} rows are not listed with every category listed and every nest open`);
    if (new Set(rows.map(({ key }) => key)).size !== rows.length) say("two rows have one key");
    if (!listed.has(step)) say("the chosen step is not listed");
    const lines = rows.filter((row) => row.kind === "exchange");
    if (lines.length !== listed.size) say(`${lines.length} exchange lines for ${listed.size} listed steps`);

    // Every exchange stands in the nest of the agent that sent it, the main agent's and an unrecorded sender's in none.
    const around: NestRow[] = [];
    rows.forEach((row, index) => {
      while (around.length > 0 && around.at(-1)!.depth >= row.depth) around.pop();
      if (row.kind === "exchange") {
        const { sender } = row.exchange;
        const within = around.at(-1)?.agent;
        if (sender.kind !== "subagent" ? within !== undefined : within !== sender.id) say(`${row.key}, sent by ${sender.kind === "subagent" ? sender.id : sender.kind}, stands in ${within ?? "no nest"}`);
        if (row.depth !== around.length) say(`${row.key} is ${row.depth} in, in ${around.length} nests`);
      }
      if (row.kind !== "nest") return;
      const parent = around.at(-1)?.agent;
      around.push(row);
      const agent = wire.get(row.agent);
      if (agent === undefined) return say(`${row.key} is the nest of ${row.agent}, which sent no step by now`);
      found.agents.add(row.agent);
      // Its parent's: one level in from the nest of the agent its header names, where that one sent first.
      if (parent !== agent.parent) say(`${row.key} stands in ${parent ?? "no nest"} where its parent is ${agent.parent ?? "the main agent"}`);
      if (agent.call === undefined) {
        if (row.stands.kind !== "end" || row.stands.unrecorded !== agent.unrecorded) say(`${row.key} stands ${row.stands.kind === "end" ? `at the end, parent unrecorded ${row.stands.unrecorded}` : "under a call"} where it is not yet tied`);
        // At its parent's end: no step of its parent's after it, before the rows its parent's nest is in go on.
        const rest = rows.slice(index + 1);
        const end = rest.findIndex((later) => later.depth < row.depth);
        const next = rest.slice(0, end === -1 ? undefined : end).find((later) => later.depth === row.depth && later.kind === "exchange");
        if (next !== undefined) say(`${row.key}, not yet tied, stands before ${next.key}`);
      } else {
        found.tied.add(row.agent);
        // Right after its call's row, or after the nests that stand there before it.
        const before = rows.slice(0, index).findLast((earlier) => earlier.depth <= row.depth && !(earlier.kind === "nest" && earlier.depth === row.depth));
        const call = before?.kind === "block" ? before.versions.findLast(({ block }) => block !== undefined)?.block?.stated : undefined;
        if (row.stands.kind !== "call" || call?.kind !== "call" || call.id !== agent.call) say(`${row.key} stands after ${before?.key ?? "nothing"}, where its call is ${agent.call}`);
      }
      if (agent.runs) found.running.add(row.agent);
      if (row.runs !== agent.runs || row.latest !== agent.latest) say(`${row.key} ${row.runs ? "runs" : "is done"} saying ${row.latest?.name ?? "nothing"}, where the wire has it ${agent.runs ? "run" : "done"} saying ${agent.latest?.name ?? "nothing"}`);
    });
  }
  return broken;
}

// A recording's events, read a line at a time. [LAW:effects-at-boundaries] Each exchange is formatted once its end
// arrives, and its bodies' text then dropped: the formatter keeps what it decoded of a side whose latest event is
// unchanged (format/format.ts), so the recording is held as its blocks, not as its encoded bodies.
async function read(recording: string, format: (exchanges: Exchange[]) => FormattedExchange[]): Promise<FormattedExchange[]> {
  const pending = new Map<string, RecordedEvent[]>();
  const built = new Map<string, Exchange>();
  const order: string[] = [];
  const drop = (exchange: Exchange) => {
    for (const event of [...exchange.request.body, ...exchange.response.body]) event.base64 = "";
  };
  for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) {
    if (line === "") continue;
    const event = JSON.parse(line) as RecordedEvent;
    if (!pending.has(event.trace_id) && !built.has(event.trace_id)) order.push(event.trace_id);
    pending.set(event.trace_id, [...(pending.get(event.trace_id) ?? []), event]);
    if (event.type !== "end") continue;
    const [exchange] = exchanges(pending.get(event.trace_id)!);
    pending.delete(event.trace_id);
    built.set(event.trace_id, exchange!);
    format([exchange!]);
    drop(exchange!);
  }
  for (const [trace, events] of pending) built.set(trace, exchanges(events)[0]!);
  return format(order.map((trace) => built.get(trace)!));
}

const expanded = Object.fromEntries(categories.map((category) => [category, "expanded"])) as Record<Category, Visibility>;
if (process.argv.length < 3) throw new Error("Give the recordings to check: node packages/ui/check/column.ts <recording.jsonl>...");
let failed = false;
for (const recording of process.argv.slice(2)) {
  const formatted = await read(recording, createFormatter());
  const history = createHistory()(formatted);
  const steps = formatted.map(stepOf);
  const open = Object.fromEntries(steps.flatMap(({ sender }) => (sender.kind === "subagent" ? [[`nest:${sender.id}`, true] as const] : [])));
  const layOut = createLayout(expanded);
  const found: Found = { steps: steps.length, unchecked: steps.filter(({ sender }) => sender.kind === "unknown").length, agents: new Set(), tied: new Set(), running: new Set() };
  const broken = check(steps, (step) => layOut(history, step, undefined, open), found);
  console.log(
    `${recording}: ${found.steps} steps (${found.unchecked} unchecked, their sender not recorded), ${found.agents.size} subagents, ${found.tied.size} tied, ${found.running.size} seen running: ${broken.length === 0 ? "every promise kept" : `${broken.length} broken`}`,
  );
  for (const what of broken.slice(0, 40)) console.error(`  ${what}`);
  failed ||= broken.length > 0;
}
process.exitCode = failed ? 1 : 0;
