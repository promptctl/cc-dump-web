import { fitting, formatError, Misfit, parseJson, readObject, type Block } from "./blocks.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the blocks of the events that are not part of it (an error event, an event this view cannot apply),
// and the text after the last complete event, which is the next event still arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; blocks: Block[]; tail: string };

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that cannot be applied is
// shown raw under its event name, with why.
export function reassemble(text: string): Stream {
  const { events, tail } = serverSentEvents(text);
  let message: Record<string, unknown> | undefined;
  const content = new Map<number, { block: Record<string, unknown>; json: string }>();
  const blocks: Block[] = [];

  const started = (index: unknown) => {
    const target = typeof index === "number" ? content.get(index) : undefined;
    if (target === undefined) throw new Misfit(`no content block ${JSON.stringify(index)} has started`);
    return target;
  };
  const apply = (data: unknown) => {
    const event = readObject(data, "event");
    const type = event.string("type");
    switch (type) {
      case "message_start":
        message = { ...readObject(event.value("message"), "message").rest() };
        return;
      case "content_block_start": {
        if (message === undefined) throw new Misfit("content_block_start before message_start");
        const index = event.value("index");
        if (typeof index !== "number") throw new Misfit("content_block_start's index is not a number");
        content.set(index, { block: readObject(event.value("content_block"), "content_block").rest(), json: "" });
        return;
      }
      case "content_block_delta":
        return applyDelta(started(event.value("index")), event.value("delta"));
      case "content_block_stop":
        return void started(event.value("index"));
      case "message_delta": {
        if (message === undefined) throw new Misfit("message_delta before message_start");
        const delta = readObject(event.value("delta"), "delta").rest();
        const usage = readObject(event.value("usage"), "usage").rest();
        message = { ...message, ...event.rest(), ...delta, usage: { ...(message.usage as object), ...usage } };
        return;
      }
      case "error":
        blocks.push(formatError(event));
        return;
      // A keep-alive, and the stream's end, which the trailers already mark: neither carries content.
      case "ping":
      case "message_stop":
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

// A content block with its tool input as far as it has streamed: the JSON once it parses, its text before that.
function assembled({ block, json }: { block: Record<string, unknown>; json: string }): Record<string, unknown> {
  if (json === "") return block;
  try {
    return { ...block, input: JSON.parse(json) };
  } catch {
    return { ...block, input: json };
  }
}

// Applies a content block delta to the block it extends; a delta of a type not here is not applied.
function applyDelta(target: { block: Record<string, unknown>; json: string }, data: unknown) {
  const delta = readObject(data, "delta");
  const type = delta.string("type");
  const append = (field: string, text: string) => {
    const prior = target.block[field];
    if (typeof prior !== "string") throw new Misfit(`${type} extends a block whose ${field} is not a string`);
    target.block[field] = prior + text;
  };
  switch (type) {
    case "text_delta":
      return append("text", delta.string("text"));
    case "thinking_delta":
      return append("thinking", delta.string("thinking"));
    case "signature_delta":
      return append("signature", delta.string("signature"));
    case "input_json_delta":
      target.json += delta.string("partial_json");
      return;
    case "citations_delta": {
      const prior = target.block.citations ?? [];
      if (!Array.isArray(prior)) throw new Misfit("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...prior, delta.value("citation")];
      return;
    }
    default:
      throw new Misfit(`${type} is not a delta this view applies`);
  }
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
