import { list, optional, raw as asSent, type Readers, type Unread } from "@cc-dump/log/json";

// The reply a Messages response holds, where a stream and a whole response meet: the formatter formats a reply, however
// it arrived.

// A field of a value no declaration read: where it is, and its value as sent.
export type UnreadField = Pick<Unread, "at" | "value">;

// [LAW:types-are-the-program] A block of a reply: `arriving`, as far as its stream has built it, the block its start
// sent with its text deltas applied, and its tool input as the JSON text sent so far, which is not yet JSON; or `whole`,
// as a whole response holds it, read by the content-block reader (format/blocks.ts). No field of the block says which.
export type ReplyBlock = { is: "arriving"; block: Record<string, unknown>; input: string } | { is: "whole"; block: unknown };

// Why a reply stopped, as far as the API has said.
export type Stop = { stop_reason?: unknown; stop_sequence?: unknown };

// A reply: its blocks, why it stopped, what the API counted, and its message's other fields, as sent.
export type Reply = { blocks: ReplyBlock[]; usage?: unknown; unread: readonly UnreadField[] } & Stop;

// A message as the API sends it, whole or as a stream's message_start begins it: what the formatter arranges of it. Its
// other fields are shown as they were sent.
export type Message = { content: unknown[]; usage?: unknown } & Stop;
export const messageFields: Readers<Message> = { content: list(asSent), stop_reason: optional(asSent), stop_sequence: optional(asSent), usage: optional(asSent) };

// The fields of an object no declaration read, as the object they were sent in, each by its name: a read of an object
// whose own fields are read as they were sent leaves none deeper.
export const fieldsOf = (unread: readonly UnreadField[]): Record<string, unknown> => Object.fromEntries(unread.map(({ at, value }) => [at.join("."), value]));

// The reply a message read holds, its blocks whole.
export const replyOf = ({ content, ...rest }: Message, unread: readonly UnreadField[]): Reply => ({ ...rest, blocks: content.map((block) => ({ is: "whole", block })), unread });
