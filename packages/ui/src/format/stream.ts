import { fitting, formatError, Misfit, parseJson, readObject, type Block } from "./blocks.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the blocks of the events that are not part of it (an error event, an event this view cannot apply),
// and the text after the last complete event, which is the next event still arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; blocks: Block[]; tail: string };

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that cannot be applied is
// shown raw under its event name, with why; the fields of an event that no case reads land on what it builds, the
// message or the content block, so a field the API adds to an event is shown with theirs.
export function reassemble(text: string): Stream {
  const { events, tail } = serverSentEvents(text);
  let message: Record<string, unknown> | undefined;
  const content = new Map<number, Building>();
  const blocks: Block[] = [];

  // Every event but message_start and an error builds on the message message_start began.
  const begun = (type: string) => {
    if (message === undefined) throw new Misfit(`${type} before message_start`);
    return message;
  };
  const started = (index: unknown) => {
    const target = typeof index === "number" ? content.get(index) : undefined;
    if (target === undefined) throw new Misfit(`no content block ${JSON.stringify(index)} has started`);
    return target;
  };
  const apply = (data: unknown) => {
    const event = readObject(data, "event");
    const type = event.string("type");
    switch (type) {
      case "message_start": {
        // Its type read as a non-streaming response's is, so both leave the same fields to show.
        const start = readObject(event.value("message"), "message");
        if (start.value("type") !== "message") throw new Misfit("message_start's message is not a message");
        message = { ...start.rest(), ...event.rest() };
        return;
      }
      case "content_block_start": {
        begun(type);
        const index = event.value("index");
        if (typeof index !== "number") throw new Misfit("content_block_start's index is not a number");
        if (content.has(index)) throw new Misfit(`content block ${index} has already started`);
        content.set(index, { block: { ...readObject(event.value("content_block"), "content_block").rest(), ...event.rest() }, json: "" });
        return;
      }
      case "content_block_delta": {
        const target = started(event.value("index"));
        applyDelta(target, event.value("delta"));
        Object.assign(target.block, event.rest());
        return;
      }
      case "content_block_stop": {
        const target = started(event.value("index"));
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        if (target.json !== "") parseJson(target.json, "the block's streamed input");
        Object.assign(target.block, event.rest());
        return;
      }
      case "message_delta": {
        const delta = readObject(event.value("delta"), "delta").rest();
        const usage = readObject(event.value("usage"), "usage").rest();
        const prior = begun(type);
        message = { ...prior, ...event.rest(), ...delta, usage: { ...(prior.usage as object), ...usage } };
        return;
      }
      case "error":
        blocks.push(formatError(event));
        return;
      // A keep-alive, and the stream's end, which the trailers already mark: neither carries content.
      case "ping":
      case "message_stop":
        message = { ...begun(type), ...event.rest() };
        return;
      default:
        throw new Misfit(`${type} is not an event this view applies`);
    }
  };

  for (const { name, data } of events) {
    fitting(
      () => apply(parseJson(data, "its data")),
      (reason) =>
        void blocks.push({
          category: "metadata",
          name: `${name} event`,
          parts: [
            { kind: "text", label: "not applied", text: reason },
            { kind: "text", label: "data", text: data },
          ],
        }),
    );
  }
  const built = message === undefined ? undefined : { ...message, content: [...content.entries()].sort(([a], [b]) => a - b).map(([, built]) => assembled(built)) };
  return { message: built, blocks, tail };
}

// A content block being built from its events: the block, and its tool input's JSON as far as it has streamed.
type Building = { block: Record<string, unknown>; json: string };

// A content block with its tool input as far as it has streamed: the JSON once it parses, its text before that.
function assembled({ block, json }: Building): Record<string, unknown> {
  if (json === "") return block;
  try {
    return { ...block, input: JSON.parse(json) };
  } catch {
    return { ...block, input: json };
  }
}

// Applies a content block delta to the block it extends, its fields no case reads among them; a delta of a type not
// here is not applied.
function applyDelta(target: Building, data: unknown) {
  const delta = readObject(data, "delta");
  const type = delta.string("type");
  // A delta extends its field from nothing when the block's start did not carry it.
  const append = (field: string, text: string) => {
    const prior = target.block[field] ?? "";
    if (typeof prior !== "string") throw new Misfit(`${type} extends a block whose ${field} is not a string`);
    target.block[field] = prior + text;
  };
  switch (type) {
    case "text_delta":
      append("text", delta.string("text"));
      break;
    case "thinking_delta":
      append("thinking", delta.string("thinking"));
      break;
    case "signature_delta":
      append("signature", delta.string("signature"));
      break;
    case "input_json_delta":
      target.json += delta.string("partial_json");
      break;
    case "citations_delta": {
      const prior = target.block.citations ?? [];
      if (!Array.isArray(prior)) throw new Misfit("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...prior, delta.value("citation")];
      break;
    }
    default:
      throw new Misfit(`${type} is not a delta this view applies`);
  }
  Object.assign(target.block, delta.rest());
}

// The complete events of a server-sent event stream (each ended by a blank line), and the text after the last.
// Per the WHATWG spec: lines end in CRLF, LF or CR; `data` lines join with LF; a line starting with a colon is a
// comment; one space after a field's colon is dropped; an event with no `event` field is named "message".
function serverSentEvents(text: string): { events: { name: string; data: string }[]; tail: string } {
  const chunks = text.replace(/\r\n?/g, "\n").split("\n\n");
  const tail = chunks.pop() ?? "";
  const events = chunks.flatMap((chunk) => {
    let name = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") name = value;
      if (field === "data") data.push(value);
    }
    // An event with no data line is not dispatched.
    return data.length === 0 ? [] : [{ name, data: data.join("\n") }];
  });
  return { events, tail };
}
