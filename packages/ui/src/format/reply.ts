import { kinds, list, nullable, object, optional, raw as asSent, string, value, type Readers, type Unread } from "@cc-dump/log/json";

// The reply a Messages response holds, where a stream and a whole response meet: the formatter formats a reply, however
// it arrived.

// A field of a value no declaration read: where it is, and its value as sent.
export type UnreadField = Pick<Unread, "at" | "value">;

// [LAW:one-source-of-truth] Fields with each of `updates` set, by path: one held keeps its place, and one not held
// follows, as each event of a stream updates what the events before it sent.
export const updated = (fields: readonly UnreadField[], updates: readonly UnreadField[]): UnreadField[] => [
  ...new Map([...fields, ...updates].map((field) => [JSON.stringify(field.at), field])).values(),
];

// [LAW:types-are-the-program] What a block's deltas grow while it streams, by its type: a text's text and citations, a
// thinking's thinking and signature, a tool use's input as the JSON text sent so far, which is not yet JSON; or
// nothing, for a block whose start sends it whole. Each type's entry says which (format/blocks.ts).
export type Grows =
  | { by: "text"; text: string; citations: readonly unknown[] | undefined }
  | { by: "thinking"; thinking: string; signature: string | undefined }
  | { by: "input"; input: string }
  | { by: "nothing" };

// A block still arriving: the block its start sent, as sent, and what its deltas have grown of it.
export type Arriving = { start: Record<string, unknown>; grows: Grows };

// The block an arriving one is so far: its start's, each field its deltas grow as grown. A tool use's input stands as
// its start sent it, since the JSON text sent so far is not yet JSON.
export function sentSoFar({ start, grows }: Arriving): Record<string, unknown> {
  switch (grows.by) {
    case "text":
      return { ...start, text: grows.text, ...(grows.citations === undefined ? {} : { citations: grows.citations }) };
    case "thinking":
      return { ...start, thinking: grows.thinking, ...(grows.signature === undefined ? {} : { signature: grows.signature }) };
    case "input":
    case "nothing":
      return start;
  }
}

// [LAW:types-are-the-program] A block of a reply, at its `index` in the stream, a whole response's its place in its
// content, and the fields its events sent that no declaration reads, each by its path from its event's name: `arriving`,
// as far as its stream has built it; `whole`, as a whole response holds it, read by the content-block reader
// (format/blocks.ts); or `refused`, a block its stream stopped that is not one, with why. No field of the block says
// which.
export type ReplyBlock = { index: number; events: readonly UnreadField[] } & (
  | { is: "arriving"; arriving: Arriving }
  | { is: "whole"; block: unknown }
  | { is: "refused"; why: string; block: unknown }
);

// [LAW:one-source-of-truth] Why a reply stopped, as far as the API has said, declared once for a whole message and a
// stream's message_delta alike: null until it has.
export type Stop = { stop_reason?: string | null; stop_sequence?: string | null };
export const stopFields: Readers<Stop> = { stop_reason: optional(nullable(string)), stop_sequence: optional(nullable(string)) };

// [LAW:types-are-the-program] What the API counted of a reply: each count, null or not sent where it said none. A
// stream's message_delta sends the counts so far, which replace those before.
export type Usage = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null };
};
const count = optional(nullable(value(kinds.integer)));
export const usage = object<Usage>({
  input_tokens: count,
  cache_creation_input_tokens: count,
  cache_read_input_tokens: count,
  output_tokens: count,
  output_tokens_details: optional(object<{ thinking_tokens?: number | null }>({ thinking_tokens: count })),
});

// A reply: its blocks, why it stopped, what the API counted, null or not sent as it said none, its message's other
// fields, as sent, and the fields its stream's events sent beside the message, each by its path from its event's name.
export type Reply = { blocks: readonly ReplyBlock[]; stop: Stop; usage: Usage | null | undefined; unread: readonly UnreadField[]; events: readonly UnreadField[] };

// A message as the API sends it, whole or as a stream's message_start begins it: what the formatter arranges of it. Its
// other fields are shown as they were sent. A usage of null counts nothing.
export type Message = { type: "message"; content: unknown[]; usage?: Usage | null } & Stop;
export const messageFields: Readers<Omit<Message, "type">> = { content: list(asSent), usage: optional(nullable(usage)), ...stopFields };

// The reply a message read holds, its blocks whole. Its `type` is the message's tag, which a reply is not.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const replyOf = ({ content, usage: counted, type: _message, ...stop }: Message, unread: readonly UnreadField[]): Reply => ({
  blocks: content.map((block, index) => ({ index, events: [], is: "whole", block })),
  stop,
  usage: counted,
  unread,
  events: [],
});
