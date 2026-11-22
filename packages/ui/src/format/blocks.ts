import { attempt, kinds, mapped, nullable, object, optional, parse, raw as rawValue, readShown, value, type Reader, type Readers, type Unread } from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { fieldValue, receivedParts, unreadParts, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
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

// [LAW:parse-dont-validate] A fact a value states, read on its own from its field `name` by `reader`: none where that
// field does not read, whatever its other fields hold, so a block shown raw still states every fact whose own field
// reads.
export const fact = <T>(json: unknown, name: string, reader: Reader<T>): T | undefined =>
  attempt(
    () => parse(object<Record<string, T>>({ [name]: reader }), json, name)[name],
    () => undefined,
  );

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
// The fields beside its error are shown after it.
export function formatError(json: unknown, what: string): Block {
  const { value, unread } = readShown(object({ type: rawValue, error: rawValue }), json, what);
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: value.error }, ...unreadParts(unread)] };
}

// The fields of a value no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// What a content block shows, read from its fields: its parts, and its name where it is not its type.
type Shown = { parts: Part[]; name?: string };

// How one content block type is shown. `category` from the role of the message holding it and the block as sent, so a
// block its entry cannot read has the same one. `show`: what it shows, read once from its fields, a text block's text
// read in `form`: Markdown in a message, verbatim in what a tool or a document returned; the fields it does not read, at
// any depth, are shown after its parts. `states`: each fact the block states (Stated), and whether it says its tool
// failed, each read on its own from its own field (`fact`), so one its show cannot read states them too.
type Entry = {
  category: (role: Role, block: unknown) => Category;
  show: (role: Role, form: Form) => Reader<Shown>;
  states?: (block: unknown, role: Role) => Stated & { failed?: true };
};

// A show read from the block's `readers` fields, beside its type, which names it.
const showing =
  <T>(readers: Readers<T>, show: (fields: T & { type: string }) => Shown): Reader<Shown> =>
    mapped(object<T & { type: string }>({ ...readers, type: text } as Readers<T & { type: string }>), show);

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thought = (_: Role, block: unknown): Category => ((fact(block, "thinking", text) ?? "") === "" ? "usage" : "thinking");
// How long a value the view does not show is, as the field naming it.
const length = (name: string, held: string | undefined): Field => [name, held === undefined ? "none" : `${held.length} characters`];

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON.
const toolUse = (read: (name: string, input: unknown) => Part[]): Pick<Entry, "category" | "show"> => ({
  category: tools,
  show: () =>
    showing({ name: text, id: text, input: rawValue }, ({ type, name, id, input }) => ({
      name: `${type}: ${name}`,
      // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is:
      // the input's deltas' `partial_json`, joined, another text than the input it becomes.
      parts: [
        ...(typeof input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input } as const] : read(name, input)),
        { id: "id", kind: "fields", fields: [["id", id]] },
      ],
    })),
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call whose id does not read states none.
const launchOf = (name: string | undefined, input: unknown): Launch | undefined => {
  const skill = fact(input, "skill", text);
  if (name === "Agent") return { tool: "Agent", type: fact(input, "subagent_type", text) };
  return name === "Skill" && skill !== undefined ? { tool: "Skill", skill } : undefined;
};
const called = (block: unknown): Stated => {
  const id = fact(block, "id", text);
  const name = fact(block, "name", text);
  return id === undefined ? {} : { call: { id, launches: launchOf(name, fact(block, "input", rawValue)), waits: name !== "SubagentHandback" } };
};

// What a client tool's result states: the call it answers, and the agent its texts name; that its tool failed, as its
// is_error says. One whose tool_use_id does not read answers none.
const answered = (block: unknown): Stated & { failed?: true } => {
  const id = fact(block, "tool_use_id", text);
  const content = fact(block, "content", contents);
  const texts = content === undefined ? [] : asBlocks(content).flatMap((one) => fact(one, "text", text) ?? []);
  return { ...(id === undefined ? {} : { result: { answers: id, names: namedIn(texts) } }), ...(fact(block, "is_error", value(kinds.boolean)) ? { failed: true } : {}) };
};

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (block: unknown, role: Role): Stated => {
  const said = role === "assistant" ? fact(block, "text", text) : undefined;
  const summary = said === undefined ? undefined : summaryEnding.exec(said)?.[1]!.trim();
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent.
const toolResult: Entry = {
  category: tools,
  states: answered,
  show: (role) =>
    showing({ tool_use_id: text, content: optional(contents), is_error: optional(rawValue) }, ({ tool_use_id, content, is_error }) => ({
      parts: [
        ...(content === undefined ? [] : contentParts(content, role)),
        { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])] },
      ],
    })),
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry = {
  category: tools,
  states: (block) => (fact(fact(block, "content", rawValue), "type", text)?.endsWith("_error") ? { failed: true } : {}),
  show: () =>
    showing({ content: rawValue, tool_use_id: text }, ({ content, tool_use_id }) => ({
      parts: [
        { id: "content", label: "content", kind: "json", value: content },
        { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
      ],
    })),
};
const ofSource = (of: Medium): Entry => ({ category: byRole, show: (role) => showing({ source: source(of, role) }, ({ source }) => ({ parts: source })) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, show: (_, form) => showing({ text }, ({ text }) => ({ parts: [textPart(text, form)] })), states: summarized }],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      category: thought,
      show: () =>
        showing({ thinking: text, signature: optional(text) }, ({ thinking, signature }) => ({
          parts: [
            { id: "thinking", kind: "text", form: "markdown", text: thinking },
            { id: "signature", kind: "fields", fields: [length("signature", signature)] },
          ],
        })),
    },
  ],
  ["redacted_thinking", { category: thought, show: () => showing({ data: text }, ({ data }) => ({ parts: [{ id: "data", kind: "fields", fields: [length("data", data)] }] })) }],
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
  ["tool_use", { ...toolUse(inputParts), states: called }],
  ["server_tool_use", toolUse((_, input) => jsonInput(input))],
  ["mcp_tool_use", toolUse((_, input) => jsonInput(input))],
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
          parts: [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role)],
        })),
    },
  ],
]);

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block its entry cannot
// read is shown the same way, with why, and states what its own fields say.
export function formatBlock(block: unknown, role: Role, form: Form): Block {
  const type = fact(block, "type", text) ?? "block";
  const entry = entries.get(type);
  if (entry === undefined) return { category: byRole(role), name: type, parts: [{ id: "block", kind: "json", value: block }] };
  const category = entry.category(role, block);
  const shown = attempt(
    (): Block => {
      const { value, unread } = readShown(entry.show(role, form), block, type);
      return { category, name: value.name ?? type, parts: [...value.parts, ...unreadParts(unread)] };
    },
    (reason) => raw(category, type, reason, { kind: "json", value: block }),
  );
  const { failed, ...stated } = entry.states?.(block, role) ?? {};
  // A tool's result that says its tool failed is named for it.
  return failed ? { ...shown, ...stated, name: `${shown.name}: error`, failed } : { ...shown, ...stated };
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(block: unknown, role: Role): Block[] {
  const formatted = formatBlock(block, role, "markdown");
  const said = fact(block, "type", text) === "text" ? fact(block, "text", text) : undefined;
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
// named under its block's index in the list, which only grows at its end. Its text is what the tool or the source
// returned, read verbatim.
function contentParts(content: unknown[] | string, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}

// An image's or a document's source, read by its type: media the view shows, the text a text document holds, or the
// blocks of a content document. A source of another type shows its type; its other fields are among the block's fields
// no read asked for.
const source =
  (of: Medium, role: Role): Reader<Part[]> =>
  (json, at) => {
    const type = object({ type: text })(json, at).value.type;
    const media = (readers: Readers<Record<string, string>>) =>
      mapped(object({ type: text, ...readers }), ({ type, ...fields }): Part[] => [{ id: "source", kind: "media", of, source: { type, ...fields } as Extract<Part, { kind: "media" }>["source"] }]);
    const sources: Record<string, Reader<Part[]>> = {
      base64: media({ media_type: text, data: text }),
      url: media({ url: text }),
      file: media({ file_id: text }),
      text: mapped(object({ type: text, data: text }), ({ data }): Part[] => [{ id: "source", kind: "text", form: "verbatim", text: data }]),
      content: mapped(object({ type: text, content: contents }), ({ content }) => contentParts(content, role)),
    };
    return (sources[type] ?? mapped(object({ type: text }), (): Part[] => [{ id: "source", label: "source", kind: "fields", fields: [["type", type]] }]))(json, at);
  };
