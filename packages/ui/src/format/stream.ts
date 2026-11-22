import { readShown } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, unreadBlock, type Block } from "./blocks.ts";
import { apply, event, type State } from "./reply.ts";

// A streamed Messages response, reassembled: the reply as far as its events have built it, the errors its error events
// returned, which stand where the reply would have, the blocks of its other events that are not part of the reply (a
// ping's fields, an event this view cannot apply), and the text after the last complete event, which is the next event
// still arriving or what a cut-off stream left.
export type Stream = { reply: State; errors: Block[]; blocks: Block[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied
// before are not parsed or applied again, so a response read while it streams costs the text it receives, not its
// whole length each time.
// [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only grows, so each
// call's text begins with the text before, and the stream equals a reassembly of all of it at once. Each call returns
// lists of its own, and a reply is never changed after it is returned (format/reply.ts).
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// Reassembles the server-sent events of a Messages stream into the reply they build (format/reply.ts).
// [LAW:no-silent-failure] An event that cannot be applied is shown raw under its event name, with why.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let state: State = { at: "before" };
  const errors: Block[] = [];
  const blocks: Block[] = [];

  // Why an event's data is not applied, or none, the reply then built on. The Messages API names every event by its
  // data's type, and `serverSentEvents` names one with no `event:` line `message`, so an event named otherwise than its
  // type, or not named, is not applied.
  const applied = (name: string, data: string): string | undefined => {
    const shown = readShown(event, data);
    if (shown.is === "refused") return shown.why;
    const read = shown.read.value;
    if (read.tag !== name) return `its type ${read.tag} is not its event's name`;
    const outcome = apply(state, read);
    if (outcome.is === "refused") return outcome.why;
    state = outcome.state;
    // A keep-alive builds nothing: a field it carries is shown on its own.
    if (read.tag === "ping") blocks.push(...unreadBlock(read.fields.unread, "http", "ping event"));
    if (read.tag === "error") errors.push(formatError(read.fields.value.error, read.fields.unread));
    return undefined;
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event: name, data } of events) {
        const why = applied(name, data);
        if (why === undefined) continue;
        blocks.push({
          category: "http",
          name: `${name} event`,
          parts: [
            { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: why },
            { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
          ],
        });
      }
      return { reply: state, errors: [...errors], blocks: [...blocks], tail };
    },
  };
}
