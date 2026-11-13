// The long regions of a block's text, which collapse and expand as a block does (docs/design/01-mvp.md, F4): fenced code
// blocks and XML-tagged sections, such as the system reminders Claude Code puts in a user's message.

// A text as runs of plain text and the long regions between them. A region is its opening line, its body (segmented
// the same way, except a code block's, which is code), and its closing line, empty when the text ends before one.
// `lines`: how many lines it spans, its opening and closing lines among them.
// [LAW:types-are-the-program] `line`, the index of its opening line in the text, names a region: a text only grows at
// its end, so it is the same line however much arrives after it, and whatever region comes to enclose it.
export type Segment = { kind: "text"; text: string } | { kind: "region"; line: number; label: string; lines: number; open: string; body: Segment[]; close: string };

// A region longer than this many lines collapses; a shorter one stays in its text.
export const LONG = 12;

// A line opening a fenced code block (CommonMark: three or more backticks or tildes, indented at most three spaces).
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A line opening an XML-tagged section: it starts with an opening tag, whose name its closing tag repeats.
const tag = /^\s*<([A-Za-z][\w.:-]*)(?:\s[^>]*)?>/;
const closingTag = /<\/([A-Za-z][\w.:-]*)>/g;

export function segments(text: string): Segment[] {
  // Each line keeps its line end, so the segments join back into the text.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return segment(scan(lines), 0, lines.length);
}

// A text's lines, read once in order: each fenced code block, by its opening line, and the lines outside code blocks
// each tag name closes on, ascending. A section's closing line is then looked up, not searched for, and a closing tag
// inside a code block is code, not the end of a section.
type Scanned = { lines: string[]; fences: Map<number, Fence>; closings: Map<string, number[]> };
// A fenced code block: its label, and its closing line, undefined when the text ends before one.
type Fence = { label: string; close: number | undefined };

function scan(lines: string[]): Scanned {
  const fences = new Map<number, Fence>();
  const closings = new Map<string, number[]>();
  for (let at = 0; at < lines.length; ) {
    const code = fence.exec(lines[at]!.trimEnd());
    if (code) {
      const [, marker, info] = code;
      const closing = new RegExp(`^ {0,3}${marker![0] === "`" ? "`" : "~"}{${marker!.length},}\\s*$`);
      const close = indexFrom(lines, at + 1, (candidate) => closing.test(candidate.trimEnd()));
      fences.set(at, { label: `${marker}${info!.trim()}`, close });
      at = close === undefined ? lines.length : close + 1;
      continue;
    }
    for (const [, name] of lines[at]!.matchAll(closingTag)) {
      const list = closings.get(name!) ?? [];
      list.push(at);
      closings.set(name!, list);
    }
    at++;
  }
  return { lines, fences, closings };
}

function segment(scanned: Scanned, from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let run = "";
  const flush = () => {
    if (run !== "") out.push({ kind: "text", text: run });
    run = "";
  };
  for (let at = from; at < to; ) {
    const region = regionAt(scanned, at, to);
    if (region.end - at > LONG) {
      flush();
      out.push(region.segment());
    } else {
      run += scanned.lines.slice(at, region.end).join("");
    }
    at = region.end;
  }
  flush();
  return out;
}

// The region opening at line `at`, ending before `to`, and its segment; a line that opens none is a region of its own
// line, which no threshold makes long.
function regionAt(scanned: Scanned, at: number, to: number): { end: number; segment: () => Segment } {
  const { lines, fences, closings } = scanned;
  const line = lines[at]!;
  const single = { end: at + 1, segment: () => ({ kind: "text" as const, text: line }) };
  const code = fences.get(at);
  if (code) {
    // A code block inside a section closes inside it, since a closing tag inside a code block does not close a section.
    const end = code.close === undefined ? to : code.close + 1;
    const body = lines.slice(at + 1, code.close ?? to).join("");
    return {
      end,
      segment: () => ({
        kind: "region",
        line: at,
        label: code.label,
        lines: end - at,
        open: line,
        body: body === "" ? [] : [{ kind: "text", text: body }],
        close: code.close === undefined ? "" : lines[code.close]!,
      }),
    };
  }
  const section = tag.exec(line);
  if (section) {
    const name = section[1]!;
    // A tag closed on its own line is not a section, nor one that does not close inside the region around it.
    const close = line.includes(`</${name}>`) ? undefined : firstAfter(closings.get(name) ?? [], at);
    if (close === undefined || close >= to) return single;
    return {
      end: close + 1,
      segment: () => ({ kind: "region", line: at, label: `<${name}>`, lines: close + 1 - at, open: line, body: segment(scanned, at + 1, close), close: lines[close]! }),
    };
  }
  return single;
}

function indexFrom(lines: string[], from: number, matches: (line: string) => boolean): number | undefined {
  for (let at = from; at < lines.length; at++) if (matches(lines[at]!)) return at;
  return undefined;
}

// The first of `ascending` after `at`, by binary search.
function firstAfter(ascending: number[], at: number): number | undefined {
  let low = 0;
  let high = ascending.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ascending[middle]! <= at) low = middle + 1;
    else high = middle;
  }
  return ascending[low];
}
