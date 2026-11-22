import { split, type Piece } from "./injected.ts";
import { restParts, fieldValue, receivedParts, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import { Malformed } from "@cc-dump/log/failure";
import { attempt, jsonObject, kinds, mapped, object, optional, parse, raw as rawValue, readShown, tolerant, unreadFields, value, type Reader, type Tolerant, type TolerantReaders, type Unread } from "@cc-dump/log/json";
import { inputParts, jsonInput } from "./tools.ts";
import { namedIn, type Notice } from "./wire.ts";

// The blocks the view shows, and the formatter of the Messages API's content blocks into them.

// [LAW:one-source-of-truth] The kinds of content a block belongs to (docs/design/01-features.md, "Vocabulary"), in the order
// the filter bar lists them: what was said and sent, then the exchange's envelope by where it is from. `parameters`:
// what a request asks beside its prompt and its messages, its cache breakpoints and a message's other fields among
// them. `usage`: what the API reported about its reply, why it stopped and what it counted. `http`: the wire as it was
// received, each side's head, a body or an event not read, and how the connection ended.
export const categories = ["user", "assistant", "tools", "system", "thinking", "parameters", "usage", "http"] as const;
export type Category = (typeof categories)[number];

// [LAW:types-are-the-program] `injected`: the harness's own content in a message the user or the assistant sent, a system
// reminder, hook output or a CLAUDE.md, which the view never mistakes for what they said, whatever its category.
// `preview`: the parts the block's collapsed line reads in place of its own (docs/design/02-design.md, "Print what
// varies"), for a block whose first part with content is not what tells it from its kind's others (view/rows.ts).
// `failed`: a tool's result that says its tool failed (its is_error), which the minimap marks in the theme's error.
// [LAW:one-source-of-truth] What a block states that the history reads (view/history.ts), here and never back out of
// its parts: `call`, a client tool's call; `result`, a client tool's result; `notice`, the harness's notification that an
// agent stopped (format/wire.ts); `summary`, the summary an assistant's text ends with, as the reply to a compaction
// does, which the thread that carries it on begins with.
export type Block = { category: Category; name: string; parts: Part[]; injected?: true; preview?: PartBody[]; failed?: true } & Stated;
export type Stated = { call?: Call; result?: Answer; notice?: Notice; summary?: string };

// [LAW:types-are-the-program] A client tool's call: its `id`, which its result answers; what it `launches`, for a tool
// that runs a subagent; and whether the reply that makes it `waits` for its result, which every call's does but a
// subagent's SubagentHandback, which hands its report back and ends its work.
export type Call = { id: string; launches: Launch | undefined; waits: boolean };
// What a call launches: an Agent call a subagent, of the agent `type` it names where it names one; a Skill call the
// skill it names, which runs in a subagent when the skill forks.
export type Launch = { tool: "Agent"; type: string | undefined } | { tool: "Skill"; skill: string };
// [LAW:one-source-of-truth] What a launch is called where it is shown: an Agent call's agent type, where it names one,
// and a Skill call's skill as the command that runs it, so a skill and an agent type of one name read apart.
export const launchName = (launches: Launch): string | undefined => (launches.tool === "Agent" ? launches.type : `/${launches.skill}`);
// A client tool's result: the call it `answers`, and the agent its content `names`, where it names one (format/wire.ts).
export type Answer = { answers: string; names: string | undefined };

// What a source of at most one block gives: none, or the one, ready to spread among a group's blocks.
export type BlockOrNone = [] | [Block];

// The roles a message speaks in. Claude Code sends system-role messages among the user's and the assistant's.
export type Role = "user" | "assistant" | "system";
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-features.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
const pieces: Record<Role, (text: string) => Piece[]> = {
  user: (text) => split(text, "said"),
  assistant: (text) => [{ kind: "said", text, content: text }],
  system: (text) => split(text, "harness"),
};

// The part holding a block's fields no read asked for.
const unreadPart = { id: "unread", label: "fields" };

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Received): Block {
  return { category, name, parts: receivedParts(reason, received) };
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
export function formatError(error: unknown, unread: readonly Unread[]): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unreadParts(unread)] };
}

// The fields of an object no read asked for, as a part, when there are any.
export const unreadParts = (unread: readonly Unread[]) => restParts(unreadFields(unread), unreadPart);

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// [LAW:types-are-the-program] What a content block states, its category among it: what the history and the view read off
// it whether or not it is shown as what it was read as.
type Facts = { category: Category; failed?: true } & Stated;
// What a block shows: its parts, its name where it is not its type, and a text block's text, which `formatContent`
// splits into its pieces.
type Shown = { parts: Part[]; name?: string; text?: string };

// How one content block type is read: what it states, and what it shows, each read from the block's fields other than
// its type. [LAW:one-source-of-truth] A fact fails alone: each is read from its own field (`stating`), so a block shown
// raw, or a field beside it that does not read, loses only the facts whose own fields do not read. The show reads every
// field it shows, the facts' among them, so a fact that does not read is seen in the block shown raw, with why.
// `form`: how a text block's text reads where the block is: Markdown in a message, verbatim in what a tool or a document
// returned.
type Entry = { facts: (fields: Record<string, unknown>, role: Role) => Facts; show: (role: Role, form: Form, type: string) => Reader<Shown> };

// [LAW:parse-dont-validate] The facts `read`, a tolerant read of the fields they are in, says, as `state` makes them.
const stating =
  <F>(read: Tolerant<F>, state: (facts: F, role: Role) => Facts): Entry["facts"] =>
  (fields, role) =>
    state(read(fields, []).value, role);
const stated = (state: (role: Role) => Facts): Entry["facts"] => (_, role) => state(role);

const str = value(kinds.string);
const byRole = (role: Role): Facts => ({ category: roleCategory[role] });
const tools = (): Facts => ({ category: "tools" });

// Fields read each on its own, as facts: each none where it is missing or does not read.
const factsOf = <F,>(readers: TolerantReaders<F>): Tolerant<Partial<F>> => tolerant<Partial<F>>(readers, {});

// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thought = stating(factsOf({ thinking: str }), ({ thinking }) => ({ category: thinking === undefined || thinking === "" ? "usage" : "thinking" }));

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON.
const toolUse = (read: (name: string, input: unknown) => Part[], facts: Entry["facts"]): Entry => ({
  facts,
  show: (_, __, type) =>
    mapped(object({ name: str, id: str, input: rawValue }), ({ name, id, input }) => {
      // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it
      // is: the input's deltas' `partial_json`, joined, another text than the input it becomes.
      const parts: Part[] = typeof input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input }] : read(name, input);
      return { name: `${type}: ${name}`, parts: [...parts, { id: "id", kind: "fields", fields: [["id", id]] }] };
    }),
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call states itself by its id alone, so one whose name or input does not read still waits for its result.
const launching = factsOf<{ subagent_type: string; skill: string }>({ subagent_type: str, skill: str });
const launchOf = (name: string | undefined, input: Partial<{ subagent_type: string; skill: string }> = {}): Launch | undefined => {
  if (name === "Agent") return { tool: "Agent", type: input.subagent_type };
  return name === "Skill" && input.skill !== undefined ? { tool: "Skill", skill: input.skill } : undefined;
};
const called = stating(factsOf({ id: str, name: str, input: launching }), ({ id, name, input }) => ({
  category: "tools",
  ...(id === undefined ? {} : { call: { id, launches: launchOf(name, input), waits: name !== "SubagentHandback" } }),
}));

// The texts a tool result's content holds: itself, a string, or each of its blocks' text, for the agent they name.
const textOf = factsOf({ text: str });
const textsOf = (content: unknown): string[] => (typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((block) => textOf(block, []).value.text ?? []) : []);

// What a client tool's result states: the call it answers, and the agent its texts name, and that its tool failed, as
// its is_error says. A call's or a result's id follows what it holds: it is how the two refer to each other, not what
// either says. A result's content is optional: a result may say only that its tool failed.
const answered = stating(factsOf({ tool_use_id: str, is_error: value(kinds.boolean), content: rawValue }), ({ tool_use_id, is_error, content }) => ({
  category: "tools",
  ...(tool_use_id === undefined ? {} : { result: { answers: tool_use_id, names: namedIn(textsOf(content)) } }),
  ...(is_error === true ? { failed: true } : {}),
}));
const toolResult: Entry = {
  facts: answered,
  show: (role) =>
    mapped(object({ tool_use_id: str, is_error: optional(value(kinds.boolean)), content: rawValue }), ({ tool_use_id, is_error, content }) => {
      const id: Field[] = [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])];
      return { parts: [...(content === undefined ? [] : contentParts(content, role)), { id: "tool_use_id", kind: "fields", fields: id }] };
    }),
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry = {
  facts: stating(factsOf({ content: factsOf({ type: str }) }), ({ content }) => ({
    category: "tools",
    ...(content?.type?.endsWith("_error") ? { failed: true } : {}),
  })),
  show: () =>
    mapped(object({ content: rawValue, tool_use_id: str }), ({ content, tool_use_id }) => ({
      parts: [
        { id: "content", label: "content", kind: "json", value: content },
        { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
      ],
    })),
};
const ofSource = (of: Medium): Entry => ({ facts: stated(byRole), show: (role) => mapped(object({ source: rawValue }), ({ source }) => ({ parts: sourceParts(source, of, role) })) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = stating(textOf, ({ text }, role) => {
  const summary = role === "assistant" && text !== undefined ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return { ...byRole(role), ...(summary === undefined || summary === "" ? {} : { summary }) };
});

const shownNone = (): Reader<Shown> => mapped(object({}), () => ({ parts: [] }));

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { facts: summarized, show: (_, form) => mapped(object({ text: str }), ({ text }) => ({ parts: [textPart(text, form)], text })) }],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      facts: thought,
      show: () =>
        mapped(object({ thinking: str, signature: optional(str) }), ({ thinking, signature }) => ({
          parts: [
            { id: "thinking", kind: "text", form: "markdown", text: thinking },
            { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
          ],
        })),
    },
  ],
  ["redacted_thinking", { facts: stated(() => ({ category: "usage" })), show: () => mapped(object({ data: str }), ({ data }) => ({ parts: [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] })) }],
  ["tool_use", toolUse(inputParts, called)],
  ["server_tool_use", toolUse((_, input) => jsonInput(input), stated(tools))],
  ["mcp_tool_use", toolUse((_, input) => jsonInput(input), stated(tools))],
  ["tool_result", toolResult],
  ["mcp_tool_result", toolResult],
  ["web_search_tool_result", serverToolResult],
  ["web_fetch_tool_result", serverToolResult],
  ["code_execution_tool_result", serverToolResult],
  ["bash_code_execution_tool_result", serverToolResult],
  ["text_editor_code_execution_tool_result", serverToolResult],
  ["tool_search_tool_result", serverToolResult],
  ["container_upload", { facts: stated(tools), show: shownNone }],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    {
      facts: stated(byRole),
      show: (role) =>
        mapped(object({ source: str, title: str, content: rawValue }), ({ source, title, content }) => ({
          parts: [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role)],
        })),
    },
  ],
]);

const typed = object({ type: str });
// A block's or a source's fields but its type, which chose how the rest are read.
const typeless = (fields: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "type"));

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`, with that
// text. [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block whose type
// does not read is shown raw as a content block, and a block its entry cannot show is shown raw under its type, each
// with why, and each stating what its own fields say.
function shownBlock(block: unknown, role: Role, form: Form): { block: Block; text?: string } {
  const read = attempt<{ type: string; fields: Record<string, unknown> } | { refused: string }>(
    () => ({ type: parse(typed, block, "content block").type, fields: jsonObject(block, "content block") }),
    (why) => ({ refused: why }),
  );
  if ("refused" in read) return { block: raw(roleCategory[role], "content block", read.refused, { kind: "json", value: block }) };
  const { type, fields } = read;
  const entry = entries.get(type);
  if (entry === undefined) return { block: { category: roleCategory[role], name: type, parts: [{ id: "block", kind: "json", value: block }] } };
  // The block's fields but its type, read by its entry, which its type chose.
  const held = typeless(fields);
  const { category, failed, ...facts } = entry.facts(held, role);
  const named = (name: string): Block => ({ category, name: failed ? `${name}: error` : name, parts: [], ...facts, ...(failed ? { failed } : {}) });
  return attempt(
    () => {
      const { value, unread } = entry.show(role, form, type)(held, []);
      return { block: { ...named(value.name ?? type), parts: [...value.parts, ...unreadParts(unread)] }, ...(value.text === undefined ? {} : { text: value.text }) };
    },
    (why) => ({ block: { ...named(type), parts: receivedParts(why, { kind: "json", value: block }) } }),
  );
}

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
export const formatBlock = (block: unknown, role: Role, form: Form): Block => shownBlock(block, role, form).block;

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(block: unknown, role: Role): Block[] {
  const { block: formatted, text } = shownBlock(block, role, "markdown");
  if (text === undefined) return [formatted];
  const fields = formatted.parts.filter(({ id }) => id !== textId);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const last = index === textPieces.length - 1;
    const rest = last ? fields : [];
    const parts: Part[] = [textPart(piece.text, form), ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, formatted.category, formatted.name, parts), preview: [textPart(piece.content, form), ...rest], ...(last ? stated : {}) };
  });
}

// How a piece's text reads (docs/design/02-design.md, "Two voices"): a hook's output is what a program printed,
// verbatim; every other piece is prose a sender or the harness wrote, Markdown.
const pieceForm: Record<Piece["kind"], Form> = { said: "markdown", reminder: "markdown", hook: "verbatim", claude_md: "markdown", section: "markdown", notification: "markdown" };

// A piece as a block: what was said is named as its text block is, and what was injected for what it is.
function pieceBlock(piece: Piece, category: Category, said: string, parts: Part[]): Block {
  switch (piece.kind) {
    case "said":
      return { category, name: said, parts };
    case "reminder":
      return { category, name: "system reminder", parts, injected: true };
    case "hook":
      return { category, name: `${piece.name} hook`, parts, injected: true };
    case "claude_md":
      return { category, name: `CLAUDE.md ${piece.path}`, parts, injected: true };
    case "section":
      return { category, name: piece.title, parts, injected: true };
    case "notification":
      return { category, name: piece.notice.kind === "stop" ? "task notification" : `task notification not read: ${piece.notice.why}`, parts, injected: true, notice: piece.notice };
  }
}

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows, each
// named under its block's index in the list, which only grows at its end. Its text is what the tool or the source
// returned, read verbatim.
function contentParts(content: unknown, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  if (Array.isArray(content)) return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
  throw new Malformed("content: is neither a string nor a list of blocks");
}

// [LAW:one-type-per-behavior] An image's or a document's source, by its type, one entry each: media the view shows, the
// text a text document holds, or the blocks of a content document. A source of another type is shown as its fields.
const sources = new Map<string, (of: Medium, role: Role) => Reader<Part[]>>([
  ["base64", (of) => mapped(object({ media_type: str, data: str }), ({ media_type, data }): Part[] => [{ id: "source", kind: "media", of, source: { type: "base64", media_type, data } }])],
  ["url", (of) => mapped(object({ url: str }), ({ url }): Part[] => [{ id: "source", kind: "media", of, source: { type: "url", url } }])],
  ["file", (of) => mapped(object({ file_id: str }), ({ file_id }): Part[] => [{ id: "source", kind: "media", of, source: { type: "file", file_id } }])],
  ["text", () => mapped(object({ data: str }), ({ data }): Part[] => [{ id: "source", kind: "text", form: "verbatim", text: data }])],
  ["content", (_, role) => mapped(object({ content: rawValue }), ({ content }) => contentParts(content, role))],
]);

// An image's or a document's source as its parts, the fields its entry does not read after them.
function sourceParts(source: unknown, of: Medium, role: Role): Part[] {
  const { type } = parse(typed, source, "source");
  const fields = typeless(jsonObject(source, "source"));
  const entry = sources.get(type);
  // A source of a type not here reads none of its other fields.
  const { value, unread } = readShown(entry?.(of, role) ?? mapped(object({}), (): Part[] => [{ id: "source", label: "source", kind: "fields", fields: [["type", type]] }]), fields, "source");
  return [...value, ...restParts(unreadFields(unread), { id: "source/unread", label: "source fields" })];
}
