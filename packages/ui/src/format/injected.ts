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
// Where a kind of piece begins in a text, and the piece that begins there.
type Marker = { pattern: RegExp; piece: (match: RegExpMatchArray) => (text: string) => Piece };

const said = (text: string): Piece => ({ kind: "said", text });
const reminder = (text: string): Piece => ({ kind: "reminder", text });

// A hook's output, which Claude Code introduces with a line naming the hook, such as `SessionStart hook additional
// context:`, and which runs to the next piece's opening or the end.
const hook: Marker = { pattern: /^(\S+) hook additional context:/gm, piece: ([, name]) => (text) => ({ kind: "hook", name: name!, text }) };

// A file's contents inside a reminder: Claude Code introduces each with a line `Contents of <path> (<description>):`
// and the file's text runs to the next file's line or the end. Only a CLAUDE.md is a piece of its own; another file's
// section is a reminder, which still ends the CLAUDE.md before it, so its text is not shown as that file's.
const file: Marker = {
  pattern: /^Contents of (.+) \([^()\n]*\):$/gm,
  piece: ([, path]) => (text) => (/(^|\/)CLAUDE\.md$/.test(path!) ? { kind: "claude_md", path: path!, text } : reminder(text)),
};

// A section a system-role message holds, which the harness titles with a level-1 heading and which runs to the next
// opening; a deeper heading is inside its section. Only a system-role message has them: a person's text may hold
// headings of its own, which are what they said.
const heading: Marker = { pattern: /^# (.+)$/gm, piece: ([, title]) => (text) => ({ kind: "section", title: title!, text }) };

// What the harness wraps its content in: a tag, with the whitespace around it, which is the tag's and not the text's, so
// no text is left that is only a line break. A tag with no closing tag wraps nothing, so it stays text.
const wrapped = /\s*<(system-reminder|user-prompt-submit-hook)>[\s\S]*?<\/\1>\s*/g;

// What differs by whose text it is: the piece for text before any opening, and the openings only that text has.
const owned: Record<OwnText, { rest: (text: string) => Piece; openings: Marker[] }> = {
  said: { rest: said, openings: [] },
  harness: { rest: reminder, openings: [heading] },
};

// [LAW:one-source-of-truth] The one place a text is split. Every character of `text` is in exactly one piece, in order.
// [LAW:dataflow-not-control-flow] The same scan runs on every text; what it finds, and whose text it is, decide the
// pieces, and a text it finds nothing in is one piece of the rest.
export function split(text: string, own: OwnText): Piece[] {
  const { rest, openings } = owned[own];
  const pieces: Piece[] = [];
  let end = 0;
  for (const match of text.matchAll(wrapped)) {
    pieces.push(...within(text.slice(end, match.index), rest, [hook, ...openings]));
    pieces.push(...(match[1] === "system-reminder" ? within(match[0], reminder, [hook, file, ...openings]) : [{ kind: "hook" as const, name: "UserPromptSubmit", text: match[0] }]));
    end = match.index + match[0].length;
  }
  pieces.push(...within(text.slice(end), rest, [hook, ...openings]));
  return pieces.length === 0 ? [rest(text)] : pieces;
}

// A text cut at each opening the markers find in it: the text before the first is a `rest` piece, and each opening's
// piece runs to the next. A piece with no text is left out.
function within(text: string, rest: (text: string) => Piece, markers: Marker[]): Piece[] {
  const openings: Opening[] = markers
    .flatMap(({ pattern, piece }) => [...text.matchAll(pattern)].map((match): Opening => ({ at: match.index, piece: piece(match) })))
    .sort((a, b) => a.at - b.at);
  const cuts: Opening[] = [{ at: 0, piece: rest }, ...openings];
  return cuts.map(({ at, piece }, index) => piece(text.slice(at, cuts[index + 1]?.at))).filter((piece) => piece.text !== "");
}
