// What the harness puts into the text of a message, and the text around it: the pieces a text splits into, so each is a
// block of its own, named for what it is (docs/design/01-features.md, F3). The harness is Claude Code; its own content is a
// system reminder, hook output, the contents of a CLAUDE.md file, or, in a system-role message, a section it titles.

// [LAW:types-are-the-program] A piece is what said it, and what that says about it: a hook has its name, a CLAUDE.md
// its path and a section its title, which nothing else has. `said`: the text of whoever sent the message, which is all of
// a text nothing was injected into. `content`: what its text holds, without what marks it as what it is (the tag it is
// wrapped in, the line naming its hook or file, its title's heading), which its name already says.
export type Piece = { text: string; content: string } & (
  | { kind: "said" }
  | { kind: "reminder" }
  | { kind: "hook"; name: string }
  | { kind: "claude_md"; path: string }
  | { kind: "section"; title: string }
);

// A piece's text, and how much of its start is what marks it.
type Made = (text: string, mark: number) => Piece;

// What a message's own text is, by the role that sent it: what its sender said, or, in a system-role message, the
// harness's, which never carries what a person typed.
export type OwnText = "said" | "harness";

// A piece of text, where it begins, and how much of it is what marks it, for a part of the text that begins with that.
type Opening = { at: number; mark: number; piece: Made };
// Where a kind of piece begins in a text, and the piece that begins there, its match what marks it. `fenced`: whether it
// begins inside a fenced code block too, which is where the text is the code's, whatever it looks like.
type Marker = { pattern: RegExp; fenced: boolean; piece: (match: RegExpMatchArray) => Made };

const said: Made = (text, mark) => ({ kind: "said", text, content: text.slice(mark) });
const reminder: Made = (text, mark) => ({ kind: "reminder", text, content: text.slice(mark) });

// A hook's output, which Claude Code introduces with a line naming the hook, such as `SessionStart hook additional
// context:`. Unwrapped it runs to the next piece's opening or the end, and only a system-role message's text, which is
// the harness's, has it at its top level: a person may type such a line, which is what they said. Wrapped in a tag, it
// is what the tag's content opens with, and names the whole tag (see `wrapped`).
const hookLine = String.raw`(\S+) hook additional context:`;
const hookPiece =
  (name: string): Made =>
  (text, mark) => ({ kind: "hook", name, text, content: text.slice(mark) });
const hook: Marker = { pattern: new RegExp(`^${hookLine}`, "gm"), fenced: false, piece: ([, name]) => hookPiece(name!) };

// A file's contents inside a reminder: Claude Code introduces each with a line `Contents of <path> (<description>):`
// and the file's text runs to the next file's line or the end. Only a CLAUDE.md is a piece of its own; another file's
// section is a reminder, which still ends the CLAUDE.md before it, so its text is not shown as that file's, and whose
// line, naming the file, is what it holds, since a reminder's name does not. A file's text may hold fences of its own,
// closed or not, and so never decides where the next file begins.
const file: Marker = {
  pattern: /^Contents of (.+) \([^()\n]*\):$/gm,
  fenced: true,
  piece:
    ([, path]) =>
    (text, mark) =>
      /(^|\/)CLAUDE\.md$/.test(path!) ? { kind: "claude_md", path: path!, text, content: text.slice(mark) } : reminder(text, 0),
};

// A section a system-role message holds, which the harness titles with a level-1 heading and which runs to the next
// opening; a deeper heading is inside its section. Only a system-role message has them: a person's text may hold
// headings of its own, which are what they said.
const heading: Marker = {
  pattern: /^# (.+)$/gm,
  fenced: false,
  piece:
    ([, title]) =>
    (text, mark) => ({ kind: "section", title: title!, text, content: text.slice(mark) }),
};

// What the harness wraps its content in: a tag, with the whitespace around it, which is the tag's and not the text's, so
// no text is left that is only a line break. A tag with no closing tag wraps nothing, so it stays text.
// The harness puts each tag on a line of its own, opening and closing, so a tag is one that starts a line: a mention of
// one inside a file's text, in backticks or in a sentence, neither opens nor closes anything.
// A tag whose content opens with a hook's line is that hook's output, whole: the tag's edges are known from the wire, so
// a hook's line later in the content starts nothing. Without one, a user-prompt-submit-hook tag is that hook's, and a
// system reminder is a reminder, in which only a file opens a piece.
// Its match is the tag's opening, its name, what it wraps, and its closing, each tag's line with the whitespace around it.
const wrapped = /(\s*^<(system-reminder|user-prompt-submit-hook)>)([\s\S]*?)(^<\/\2>\s*)/gm;
const opensWithHook = new RegExp(`^\\s*${hookLine}`);

// What differs by whose text it is: the piece for text before any opening, and the markers that open a piece in its top
// level, outside every tag and fence. Inside a reminder only a file opens one, whoever's the text is.
const owned: Record<OwnText, { rest: Made; topLevel: Marker[] }> = {
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
    pieces.push(...tagged(match));
    end = match.index + match[0].length;
  }
  pieces.push(...within(text.slice(end), rest, topLevel));
  return pieces.length === 0 ? [rest(text, 0)] : pieces;
}

// The pieces of one tag and the whitespace around it: the pieces of what it wraps, which is never empty, since a tag's
// lines are its own, with the tag's opening the first's text and its closing the last's, never their content.
function tagged([, opening, tag, inner, closing]: RegExpExecArray): Piece[] {
  const hooked = opensWithHook.exec(inner!);
  const pieces =
    hooked !== null
      ? [hookPiece(hooked[1]!)(inner!, hooked[0].length)]
      : tag === "system-reminder"
        ? within(inner!, reminder, [file])
        : [hookPiece("UserPromptSubmit")(inner!, 0)];
  return pieces.map((piece, index) => ({ ...piece, text: (index === 0 ? opening : "") + piece.text + (index === pieces.length - 1 ? closing : "") }));
}

// A text cut at each opening the markers find in it: the text before the first is a `rest` piece, and each opening's
// piece runs to the next. A piece with no text is left out.
function within(text: string, rest: Made, markers: Marker[]): Piece[] {
  const code = markers.some(({ fenced }) => !fenced) ? fences(text) : [];
  const openings: Opening[] = markers
    .flatMap(({ pattern, fenced, piece }) =>
      [...text.matchAll(pattern)].filter(({ index }) => fenced || !code.some(([from, to]) => index >= from && index < to)).map((match): Opening => ({ at: match.index, mark: match[0].length, piece: piece(match) })),
    )
    .sort((a, b) => a.at - b.at);
  const cuts: Opening[] = [{ at: 0, mark: 0, piece: rest }, ...openings];
  return cuts.map(({ at, mark, piece }, index) => piece(text.slice(at, cuts[index + 1]?.at), mark)).filter((piece) => piece.text !== "");
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
