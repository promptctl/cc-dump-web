// What the harness puts into the text of a message, and the text around it: the pieces a text splits into, so each is a
// block of its own, named for what it is (docs/design/01-mvp.md, F3). The harness is Claude Code; its own content is a
// system reminder, hook output, the contents of a CLAUDE.md file, or, in a system-role message, a section it titles.

// [LAW:types-are-the-program] A piece is what said it, and what that says about it: a hook has its name, a CLAUDE.md
// its path and a section its title, which nothing else has. `said`: the text of whoever sent the message, which is all of
// a text nothing was injected into.
export type Piece =
  | { kind: "said"; text: string }
  | { kind: "reminder"; text: string }
  | { kind: "hook"; text: string; name: string }
  | { kind: "claude_md"; text: string; path: string }
  | { kind: "section"; text: string; title: string };

// What a message's own text is, by the role that sent it: what its sender said, or, in a system-role message, the
// harness's, which never carries what a person typed.
export type OwnText = "said" | "harness";

// A piece of text and where it begins, for a part of the text that begins with what marks it.
type Opening = { at: number; piece: (text: string) => Piece };
// Where a kind of piece begins in a text, and the piece that begins there. `fenced`: whether it begins inside a fenced
// code block too, which is where the text is the code's, whatever it looks like.
type Marker = { pattern: RegExp; fenced: boolean; piece: (match: RegExpMatchArray) => (text: string) => Piece };

const said = (text: string): Piece => ({ kind: "said", text });
const reminder = (text: string): Piece => ({ kind: "reminder", text });

// A hook's output, which Claude Code introduces with a line naming the hook, such as `SessionStart hook additional
// context:`. Unwrapped it runs to the next piece's opening or the end, and only a system-role message's text, which is
// the harness's, has it at its top level: a person may type such a line, which is what they said. Wrapped in a tag, it
// is what the tag's content opens with, and names the whole tag (see `wrapped`).
const hookLine = String.raw`(\S+) hook additional context:`;
const hook: Marker = { pattern: new RegExp(`^${hookLine}`, "gm"), fenced: false, piece: ([, name]) => (text) => ({ kind: "hook", name: name!, text }) };

// A file's contents inside a reminder: Claude Code introduces each with a line `Contents of <path> (<description>):`
// and the file's text runs to the next file's line or the end. Only a CLAUDE.md is a piece of its own; another file's
// section is a reminder, which still ends the CLAUDE.md before it, so its text is not shown as that file's. A file's
// text may hold fences of its own, closed or not, and so never decides where the next file begins.
const file: Marker = {
  pattern: /^Contents of (.+) \([^()\n]*\):$/gm,
  fenced: true,
  piece: ([, path]) => (text) => (/(^|\/)CLAUDE\.md$/.test(path!) ? { kind: "claude_md", path: path!, text } : reminder(text)),
};

// A section a system-role message holds, which the harness titles with a level-1 heading and which runs to the next
// opening; a deeper heading is inside its section. Only a system-role message has them: a person's text may hold
// headings of its own, which are what they said.
const heading: Marker = { pattern: /^# (.+)$/gm, fenced: false, piece: ([, title]) => (text) => ({ kind: "section", title: title!, text }) };

// What the harness wraps its content in: a tag, with the whitespace around it, which is the tag's and not the text's, so
// no text is left that is only a line break. A tag with no closing tag wraps nothing, so it stays text.
// A tag whose content opens with a hook's line is that hook's output, whole: the tag's edges are known from the wire, so
// a hook's line later in the content starts nothing. Without one, a user-prompt-submit-hook tag is that hook's, and a
// system reminder is a reminder, in which only a file opens a piece.
const wrapped = /\s*<(system-reminder|user-prompt-submit-hook)>[\s\S]*?<\/\1>\s*/g;
const opensWithHook = new RegExp(`^\\s*<[^>]+>\\s*${hookLine}`);

// What differs by whose text it is: the piece for text before any opening, and the markers that open a piece in its top
// level, outside every tag and fence. Inside a reminder only a file opens one, whoever's the text is.
const owned: Record<OwnText, { rest: (text: string) => Piece; topLevel: Marker[] }> = {
  said: { rest: said, topLevel: [] },
  harness: { rest: reminder, topLevel: [hook, heading] },
};

// [LAW:one-source-of-truth] The one place a text is split. Every character of `text` is in exactly one piece, in order.
// [LAW:dataflow-not-control-flow] The same scan runs on every text; what it finds, and whose text it is, decide the
// pieces, and a text it finds nothing in is one piece of the rest.
export function split(text: string, own: OwnText): Piece[] {
  const { rest, topLevel } = owned[own];
  const pieces: Piece[] = [];
  let end = 0;
  for (const match of text.matchAll(wrapped)) {
    pieces.push(...within(text.slice(end, match.index), rest, topLevel));
    pieces.push(...tagged(match[0], match[1]!));
    end = match.index + match[0].length;
  }
  pieces.push(...within(text.slice(end), rest, topLevel));
  return pieces.length === 0 ? [rest(text)] : pieces;
}

// The pieces of one tag and the whitespace around it.
function tagged(text: string, tag: string): Piece[] {
  const [, name] = opensWithHook.exec(text) ?? [];
  if (name !== undefined) return [{ kind: "hook", name, text }];
  return tag === "system-reminder" ? within(text, reminder, [file]) : [{ kind: "hook", name: "UserPromptSubmit", text }];
}

// A text cut at each opening the markers find in it: the text before the first is a `rest` piece, and each opening's
// piece runs to the next. A piece with no text is left out.
function within(text: string, rest: (text: string) => Piece, markers: Marker[]): Piece[] {
  const code = markers.some(({ fenced }) => !fenced) ? fences(text) : [];
  const openings: Opening[] = markers
    .flatMap(({ pattern, fenced, piece }) =>
      [...text.matchAll(pattern)].filter(({ index }) => fenced || !code.some(([from, to]) => index >= from && index < to)).map((match): Opening => ({ at: match.index, piece: piece(match) })),
    )
    .sort((a, b) => a.at - b.at);
  const cuts: Opening[] = [{ at: 0, piece: rest }, ...openings];
  return cuts.map(({ at, piece }, index) => piece(text.slice(at, cuts[index + 1]?.at))).filter((piece) => piece.text !== "");
}

// The fenced code blocks of a text, as the start and end of each, as markdown has them: a line starting with ``` or ~~~
// opens one, the next line starting with the same three characters closes it, and one never closed runs to the end.
function fences(text: string): [from: number, to: number][] {
  const blocks: [number, number][] = [];
  let open: { from: number; mark: string } | undefined;
  for (const { 0: mark, index } of text.matchAll(/^(?:```|~~~)/gm)) {
    if (open === undefined) open = { from: index, mark };
    else if (open.mark === mark) {
      blocks.push([open.from, index + mark.length]);
      open = undefined;
    }
  }
  if (open !== undefined) blocks.push([open.from, text.length]);
  return blocks;
}
