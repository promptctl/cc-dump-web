// The long regions of a block's text, which collapse and expand as a block does (docs/design/01-mvp.md, F4): fenced code
// blocks and XML-tagged sections, such as the system reminders Claude Code puts in a user's message.

// A text as runs of plain text and the long regions between them. A region is its opening line, its body (segmented
// the same way, except a code block's, which is code), and its closing line, empty when the text ends before one.
// `lines`: how many lines it spans, its opening and closing lines among them.
export type Segment = { kind: "text"; text: string } | { kind: "region"; label: string; lines: number; open: string; body: Segment[]; close: string };

// A region longer than this many lines collapses; a shorter one stays in its text.
export const LONG = 12;

// A line opening a fenced code block (CommonMark: three or more backticks or tildes, indented at most three spaces).
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A line opening an XML-tagged section: it starts with an opening tag, whose name its closing tag repeats.
const tag = /^\s*<([A-Za-z][\w.:-]*)(?:\s[^>]*)?>/;

export function segments(text: string): Segment[] {
  // Each line keeps its line end, so the segments join back into the text.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return segment(lines, 0, lines.length);
}

function segment(lines: string[], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let run = "";
  const flush = () => {
    if (run !== "") out.push({ kind: "text", text: run });
    run = "";
  };
  for (let at = from; at < to; ) {
    const region = regionAt(lines, at, to);
    if (region.end - at > LONG) {
      flush();
      out.push(region.segment());
    } else {
      run += lines.slice(at, region.end).join("");
    }
    at = region.end;
  }
  flush();
  return out;
}

// The region opening at line `at`, ending before `end`, and its segment; a line that opens none is a region of its own
// line, which no threshold makes long.
function regionAt(lines: string[], at: number, to: number): { end: number; segment: () => Segment } {
  const line = lines[at]!;
  const single = { end: at + 1, segment: () => ({ kind: "text" as const, text: line }) };
  const code = fence.exec(line.trimEnd());
  if (code) {
    const [, marker, info] = code;
    const closing = new RegExp(`^ {0,3}${marker![0] === "`" ? "`" : "~"}{${marker!.length},}\\s*$`);
    const close = indexFrom(lines, at + 1, to, (candidate) => closing.test(candidate.trimEnd()));
    const end = close === -1 ? to : close + 1;
    const body = lines.slice(at + 1, close === -1 ? to : close).join("");
    return {
      end,
      segment: () => ({
        kind: "region",
        label: `${marker}${info!.trim()}`,
        lines: end - at,
        open: line,
        body: body === "" ? [] : [{ kind: "text", text: body }],
        close: close === -1 ? "" : lines[close]!,
      }),
    };
  }
  const section = tag.exec(line);
  if (section) {
    const closing = `</${section[1]}>`;
    // A tag closed on its own line is not a section.
    if (line.includes(closing)) return single;
    const close = indexFrom(lines, at + 1, to, (candidate) => candidate.includes(closing));
    if (close === -1) return single;
    return {
      end: close + 1,
      segment: () => ({ kind: "region", label: `<${section[1]}>`, lines: close + 1 - at, open: line, body: segment(lines, at + 1, close), close: lines[close]! }),
    };
  }
  return single;
}

function indexFrom(lines: string[], from: number, to: number, matches: (line: string) => boolean): number {
  for (let at = from; at < to; at++) if (matches(lines[at]!)) return at;
  return -1;
}
