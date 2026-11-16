// The long regions of a block's text, which collapse and expand as a block does (docs/design/01-mvp.md, F4): fenced code
// blocks and XML-tagged sections, such as the system reminders Claude Code puts in a user's message.

// A text as runs of plain text and the long regions between them. A region is its opening line, its body (segmented
// the same way, except a code block's, which is code), and its closing line, empty when the text ends before one.
// `lines`: how many lines it spans, its opening and closing lines among them.
// [LAW:types-are-the-program] `line`, the index of its opening line in the text, names a region: a text only grows at
// its end, so it is the same line however much arrives after it, and whatever region comes to enclose it.
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "region"; line: number; label: string; lines: number; open: string; body: Segment[]; close: string };

// A region longer than this many lines collapses; a shorter one stays in its text.
export const LONG = 12;

// A line opening a fenced code block (CommonMark: three or more backticks or tildes, indented at most three spaces; a
// backtick fence's info string holds no backtick, so a line like ```js``` is code inline, not a fence).
const fence = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
// [LAW:one-source-of-truth] A line holding only a tag, opening or closing (`/`), its whitespace aside, as Claude Code
// writes a prompt's sections: the one definition of a section's edge, in a verbatim text and in Markdown alike. A
// self-closing tag wraps nothing, so it is no edge.
export const tagLine = /^<(\/)?([A-Za-z][\w.:-]*)(?:\s[^>]*)?(?<!\/)>$/;

export function segments(text: string): Segment[] {
  // Each line keeps its line end, so the segments join back into the text.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return segment(scan(lines), 0, lines.length);
}

// A text's lines, read once in order: each fenced code block and each XML-tagged section, by its opening line. A
// section is a line holding only an opening tag and a later line holding only its closing tag, as Claude Code writes
// a system reminder; a closing line closes the last section of its name still open, so a section quoting another of
// its name closes at its own. A tag mentioned within a line, or inside a code block, opens and closes nothing.
type Scanned = { lines: string[]; fences: Map<number, Fence>; sections: Map<number, Section> };
// A fenced code block: its label, and its closing line, undefined when the text ends before one.
type Fence = { label: string; close: number | undefined };
// An XML-tagged section: its tag's name, and its closing line.
type Section = { name: string; close: number };

function scan(lines: string[]): Scanned {
  const fences = new Map<number, Fence>();
  const sections = new Map<number, Section>();
  // The lines of the sections still open, by their tag's name, the innermost last.
  const open = new Map<string, number[]>();
  for (let at = 0; at < lines.length; ) {
    const line = lines[at]!;
    const code = fence.exec(line.trimEnd());
    if (code) {
      const [, marker, info] = code;
      const closing = new RegExp(`^ {0,3}${marker![0] === "`" ? "`" : "~"}{${marker!.length},}\\s*$`);
      const close = indexFrom(lines, at + 1, (candidate) => closing.test(candidate.trimEnd()));
      fences.set(at, { label: `${marker}${info!.trim()}`, close });
      at = close === undefined ? lines.length : close + 1;
      continue;
    }
    const [, closing, name] = tagLine.exec(line.trim()) ?? [];
    if (name !== undefined) {
      const stack = open.get(name) ?? [];
      open.set(name, stack);
      if (closing === undefined) stack.push(at);
      const opened = closing === undefined ? undefined : stack.pop();
      if (opened !== undefined) sections.set(opened, { name, close: at });
    }
    at++;
  }
  return { lines, fences, sections };
}

function segment(scanned: Scanned, from: number, to: number): Segment[] {
  const out: Segment[] = [];
  // The line the run of text before the next long region starts on.
  let run = from;
  const flush = (end: number) => {
    if (end > run) out.push(text(scanned, run, end));
  };
  for (let at = from; at < to; ) {
    const region = regionAt(scanned, at, to);
    if (region.end - at > LONG) {
      flush(at);
      out.push(region.segment());
      run = region.end;
    }
    at = region.end;
  }
  flush(to);
  return out;
}

// The lines from `from` up to `to` as a run of text.
function text({ lines }: Scanned, from: number, to: number): Segment {
  return { kind: "text", text: lines.slice(from, to).join("") };
}

// The region opening at line `at`, ending before `to`, and its segment; a line that opens none is a region of its own
// line, which no threshold makes long.
function regionAt(scanned: Scanned, at: number, to: number): { end: number; segment: () => Segment } {
  const { lines, fences, sections } = scanned;
  const line = lines[at]!;
  const single = { end: at + 1, segment: () => text(scanned, at, at + 1) };
  const code = fences.get(at);
  if (code) {
    // A code block inside a section closes inside it, since a closing tag inside a code block does not close a section.
    const end = code.close === undefined ? to : code.close + 1;
    const bodyEnd = code.close ?? to;
    return {
      end,
      segment: () => ({
        kind: "region",
        line: at,
        label: code.label,
        lines: end - at,
        open: line,
        body: bodyEnd > at + 1 ? [text(scanned, at + 1, bodyEnd)] : [],
        close: code.close === undefined ? "" : lines[code.close]!,
      }),
    };
  }
  const section = sections.get(at);
  // A section that does not close inside the region around it is text.
  if (section === undefined || section.close >= to) return single;
  const { name, close } = section;
  return {
    end: close + 1,
    segment: () => ({
      kind: "region",
      line: at,
      label: `<${name}>`,
      lines: close + 1 - at,
      open: line,
      body: segment(scanned, at + 1, close),
      close: lines[close]!,
    }),
  };
}

// [LAW:one-source-of-truth] The key a region is kept under: its part's key and the line it opens on.
export function regionKey(partKey: string, line: number): string {
  return `${partKey}/${line}`;
}

function indexFrom(lines: string[], from: number, matches: (line: string) => boolean): number | undefined {
  for (let at = from; at < lines.length; at++) if (matches(lines[at]!)) return at;
  return undefined;
}
