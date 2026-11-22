import { attempt, fieldOf, kinds, mapped, nullable, object, optional, parse, raw as rawValue, readShown, value, type Reader, type Readers, type Unread } from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { receivedParts, unreadParts, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
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
export const role = value(kinds.among(Object.keys(roleCategory) as Role[]));
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-features.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
const pieces: Record<Role, (text: string) => Piece[]> = {
  user: (text) => split(text, "said"),
  assistant: (text) => [{ kind: "said", text, content: text }],
  system: (text) => split(text, "harness"),
};

const text = value(kinds.string);

// A message's content, a system prompt, or a tool result's: a string, which is the text of one text block, or content
// blocks, as JSON holds them.
export const contents: Reader<unknown[] | string> = value({
  fits: (json): json is unknown[] | string => typeof json === "string" || Array.isArray(json),
  expected: "a string or a list of blocks",
});
export const asBlocks = (content: unknown[] | string): unknown[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Received): Block {
  return { category, name, parts: receivedParts(reason, received) };
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
// The fields beside its error, which no read asked for, are shown after it.
export function formatError(error: unknown, unread: readonly Unread[]): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unreadParts(unread)] };
}

// The fields of a value no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// [LAW:one-source-of-truth] What a content block shows, read once from its fields beside its type, and what it states
// from that same read, so a block whose read is refused is shown raw, with why, and states nothing: its parts; its name
// where it is not its type; its category where it is not its entry's; each fact it states (Stated), and whether it says
// its tool failed; and a text block's text, which `formatContent` splits.
type Shown = { parts: Part[]; name?: string; category?: Category; failed?: true; text?: string } & Stated;

// How one content block type is shown. `category` from the role of the message holding it, which a block its show
// cannot read has too. `show`: what it shows, read from its fields beside its type, a text block's text read in `form`:
// Markdown in a message, verbatim in what a tool or a document returned; the fields it does not read, at any depth, are
// shown after its parts.
type Entry = { category: (role: Role) => Category; show: (role: Role, form: Form, type: string) => Reader<Shown> };

// A show read from the block's `readers` fields.
const showing = <T>(readers: Readers<T>, show: (fields: T) => Shown): Reader<Shown> => mapped(object(readers), show);

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thinking = () => "thinking" as const;
const usage = () => "usage" as const;
// How long a value the view does not show is, as the field naming it.
const length = (name: string, held: string | undefined): Field => [name, held === undefined ? "none" : `${held.length} characters`];

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON; and what its call states.
const toolUse = (read: (name: string, input: unknown) => Part[], states: (use: { name: string; id: string; input: unknown }) => Stated): Entry => ({
  category: tools,
  show: (_, __, type) =>
    showing({ name: text, id: text, input: rawValue }, (use) => ({
      name: `${type}: ${use.name}`,
      // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is:
      // the input's deltas' `partial_json`, joined, another text than the input it becomes.
      parts: [
        ...(typeof use.input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: use.input } as const] : read(use.name, use.input)),
        { id: "id", kind: "fields", fields: [["id", use.id]] },
      ],
      ...states(use),
    })),
});
// A text a tool's input holds at `name`, where its input, an object or the text a stream has sent so far, holds one.
const inputText = (input: unknown, name: string): string | undefined => {
  const held = fieldOf(input, name);
  return typeof held === "string" ? held : undefined;
};
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends.
const launchOf = (name: string, input: unknown): Launch | undefined => {
  const skill = inputText(input, "skill");
  if (name === "Agent") return { tool: "Agent", type: inputText(input, "subagent_type") };
  return name === "Skill" && skill !== undefined ? { tool: "Skill", skill } : undefined;
};
const called = ({ name, id, input }: { name: string; id: string; input: unknown }): Stated => ({ call: { id, launches: launchOf(name, input), waits: name !== "SubagentHandback" } });

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (said: string, role: Role): Stated => {
  const summary = role === "assistant" ? summaryEnding.exec(said)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent. It answers the call its tool_use_id names, and names the agent its texts
// name (format/wire.ts). Its content is read apart from the rest, as a tool's input is (format/tools.ts): one that does
// not read shows why, and its JSON, while the result still answers its call and says whether its tool failed.
const toolResult: Entry = {
  category: tools,
  show: (role) =>
    showing({ tool_use_id: text, content: optional(rawValue), is_error: optional(value(kinds.boolean)) }, ({ tool_use_id, content, is_error }) => {
      const shown =
        content === undefined
          ? { parts: [], texts: [] }
          : attempt(
              () => contentParts(parse(contents, content, "content"), role),
              (reason) => ({ parts: receivedParts(reason, { kind: "json", value: content }), texts: [] }),
            );
      return {
        parts: [...shown.parts, { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", String(is_error)] satisfies Field])] }],
        result: { answers: tool_use_id, names: namedIn(shown.texts) },
        ...(is_error === true ? { failed: true } : {}),
      };
    }),
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each; its content is a list where it holds results.
const serverToolResult: Entry = {
  category: tools,
  show: () =>
    showing({ content: rawValue, tool_use_id: text }, ({ content, tool_use_id }) => {
      const type = fieldOf(content, "type");
      return {
        parts: [
          { id: "content", label: "content", kind: "json", value: content },
          { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
        ],
        ...(typeof type === "string" && type.endsWith("_error") ? { failed: true } : {}),
      };
    }),
};
const ofSource = (of: Medium): Entry => ({ category: byRole, show: (role) => showing({ source: source(of, role) }, ({ source }) => ({ parts: source })) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, show: (role, form) => showing({ text }, ({ text }) => ({ parts: [textPart(text, form)], text, ...summarized(text, role) })) }],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      category: thinking,
      show: () =>
        showing({ thinking: text, signature: optional(text) }, ({ thinking, signature }) => ({
          parts: [
            { id: "thinking", kind: "text", form: "markdown", text: thinking },
            { id: "signature", kind: "fields", fields: [length("signature", signature)] },
          ],
          ...(thinking === "" ? { category: "usage" } : {}),
        })),
    },
  ],
  ["redacted_thinking", { category: usage, show: () => showing({ data: text }, ({ data }) => ({ parts: [{ id: "data", kind: "fields", fields: [length("data", data)] }] })) }],
  // What the API kept of the conversation it compacted: its summary, a streamed one's once its delta has arrived, and
  // how long the content it holds for itself is.
  [
    "compaction",
    {
      category: byRole,
      show: () =>
        showing({ content: nullable(text), encrypted_content: optional(nullable(text)) }, ({ content, encrypted_content }) => ({
          parts: [
            ...(content === null ? [] : [{ id: "content", kind: "text", form: "markdown", text: content } as const]),
            { id: "encrypted_content", kind: "fields", fields: [length("encrypted_content", encrypted_content ?? undefined)] },
          ],
        })),
    },
  ],
  ["tool_use", toolUse(inputParts, called)],
  ["server_tool_use", toolUse((_, input) => jsonInput(input), () => ({}))],
  ["mcp_tool_use", toolUse((_, input) => jsonInput(input), () => ({}))],
  ["tool_result", toolResult],
  ["mcp_tool_result", toolResult],
  ["web_search_tool_result", serverToolResult],
  ["web_fetch_tool_result", serverToolResult],
  ["code_execution_tool_result", serverToolResult],
  ["bash_code_execution_tool_result", serverToolResult],
  ["text_editor_code_execution_tool_result", serverToolResult],
  ["tool_search_tool_result", serverToolResult],
  ["container_upload", { category: tools, show: () => showing({}, () => ({ parts: [] })) }],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    {
      category: byRole,
      show: (role) =>
        showing({ source: text, title: text, content: contents }, ({ source, title, content }) => ({
          parts: [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role).parts],
        })),
    },
  ],
]);

// A content block's type, read once, and its other fields, which its entry reads.
const typed = (block: unknown): { type: string; fields: Record<string, unknown> } => {
  const { type, ...fields } = parse(value(kinds.object), block, "content block");
  return { type: parse(text, type, "type"), fields };
};

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`, and a text
// block's text. [LAW:no-silent-failure] A block whose type does not read is shown as its raw JSON, with why; a type with
// no entry is shown as its raw JSON under its type name; a block its entry cannot read is shown the same way, with why.
function shownBlock(block: unknown, role: Role, form: Form): { block: Block; text: string | undefined } {
  const received = { kind: "json", value: block } as const;
  return attempt(
    () => {
      const { type, fields } = typed(block);
      const entry = entries.get(type);
      if (entry === undefined) return { block: { category: byRole(role), name: type, parts: [{ id: "block", kind: "json", value: block }] }, text: undefined };
      const category = entry.category(role);
      return attempt(
        () => {
          const { value, unread } = readShown(entry.show(role, form, type), fields, type);
          const { parts, name = type, category: shownCategory = category, failed, text, ...stated } = value;
          // A tool's result that says its tool failed is named for it.
          const named = failed ? { name: `${name}: error`, failed } : { name };
          return { block: { category: shownCategory, parts: [...parts, ...unreadParts(unread)], ...named, ...stated }, text };
        },
        (reason) => ({ block: raw(category, type, reason, received), text: undefined }),
      );
    },
    (reason) => ({ block: raw(byRole(role), "content block", reason, received), text: undefined }),
  );
}

export const formatBlock = (block: unknown, role: Role, form: Form): Block => shownBlock(block, role, form).block;

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(block: unknown, role: Role): Block[] {
  const { block: formatted, text: said } = shownBlock(block, role, "markdown");
  if (said === undefined) return [formatted];
  const fields = formatted.parts.filter(({ id }) => id !== textId);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](said);
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
// named under its block's index in the list, which only grows at its end, and the texts of its text blocks, as each
// block's read shows them. Its text is what the tool or the source returned, read verbatim.
function contentParts(content: unknown[] | string, role: Role): { parts: Part[]; texts: string[] } {
  if (typeof content === "string") return { parts: [{ id: "content", kind: "text", form: "verbatim", text: content }], texts: [content] };
  const shown = content.map((block) => shownBlock(block, role, "verbatim"));
  return {
    parts: shown.flatMap(({ block }, index) => block.parts.map((part) => ({ ...part, id: `${index}/${part.id}` }))),
    texts: shown.flatMap(({ text }) => text ?? []),
  };
}

// An image's or a document's source, by its type: media the view shows, the text a text document holds, or the blocks
// of a content document. A source of another type shows its type; its other fields are among the block's fields no read
// asked for.
type Media = Extract<Part, { kind: "media" }>["source"];
const source = (of: Medium, role: Role): Reader<Part[]> => {
  const media = <T>(readers: Readers<T>, as: (fields: T) => Media): Reader<Part[]> => mapped(object(readers), (fields): Part[] => [{ id: "source", kind: "media", of, source: as(fields) }]);
  // [LAW:one-type-per-behavior] By its type, in a Map like `entries`, so a type is only ever one of these.
  const sources = new Map<string, Reader<Part[]>>([
    ["base64", media({ type: text, media_type: text, data: text }, ({ media_type, data }) => ({ type: "base64", media_type, data }))],
    ["url", media({ type: text, url: text }, ({ url }) => ({ type: "url", url }))],
    ["file", media({ type: text, file_id: text }, ({ file_id }) => ({ type: "file", file_id }))],
    ["text", mapped(object({ type: text, data: text }), ({ data }): Part[] => [{ id: "source", kind: "text", form: "verbatim", text: data }])],
    ["content", mapped(object({ type: text, content: contents }), ({ content }) => contentParts(content, role).parts)],
  ]);
  return (json, at) => {
    const { type } = object({ type: text })(json, at).value;
    return (sources.get(type) ?? mapped(object({ type: text }), (): Part[] => [{ id: "source", label: "source", kind: "fields", fields: [["type", type]] }]))(json, at);
  };
};
