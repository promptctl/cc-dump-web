import { describe, expect, it } from "vitest";
import { LONG, segments, type Segment } from "./regions.ts";

const lines = (count: number, word = "line") => Array.from({ length: count }, (_, i) => `${word} ${i}\n`).join("");

// The text a list of segments shows when every region is expanded.
const joined = (list: Segment[]): string => list.map((segment) => (segment.kind === "text" ? segment.text : segment.open + joined(segment.body) + segment.close)).join("");

describe("segments", () => {
  it("finds a long fenced code block and keeps its body as code", () => {
    const code = "```ts\n" + lines(LONG, "<b>") + "```\n";
    const text = `Before.\n${code}After.`;
    const body = lines(LONG, "<b>");
    expect(segments(text)).toEqual([
      { kind: "text", text: "Before.\n" },
      { kind: "region", line: 1, label: "```ts", lines: LONG + 2, open: "```ts\n", body: [{ kind: "text", text: body }], close: "```\n" },
      { kind: "text", text: "After." },
    ]);
    expect(joined(segments(text))).toBe(text);
  });

  it("finds a long XML-tagged section and segments its body, so a region inside it collapses too", () => {
    const inner = "~~~\n" + lines(LONG) + "~~~\n";
    const text = `<system-reminder>\n${lines(3)}${inner}</system-reminder>\n`;
    const [section] = segments(text);
    expect(section).toMatchObject({ kind: "region", label: "<system-reminder>", lines: LONG + 7, close: "</system-reminder>\n" });
    expect((section as { body: Segment[] }).body.map((segment) => segment.kind)).toEqual(["text", "region"]);
    expect(joined(segments(text))).toBe(text);
  });

  it("keeps a region of at most LONG lines in its text", () => {
    const text = "```\n" + lines(LONG - 2) + "```\n";
    expect(segments(text)).toEqual([{ kind: "text", text }]);
  });

  it("runs a fence the text does not close to the end, as a block still streaming does", () => {
    const text = "```py\n" + lines(LONG);
    expect(segments(text)).toEqual([
      { kind: "region", line: 0, label: "```py", lines: LONG + 1, open: "```py\n", body: [{ kind: "text", text: lines(LONG) }], close: "" },
    ]);
  });

  it("takes a tag the text does not close, or closes on its own line, as text", () => {
    const text = `<thinking>\n${lines(LONG + 1)}<command-name>/clear</command-name>\n${lines(LONG + 1)}`;
    expect(segments(text)).toEqual([{ kind: "text", text }]);
  });

  it("closes a fence only with a fence of its own character, at least as long", () => {
    const text = "````\n```\n~~~~\n" + lines(LONG) + "````\nafter\n";
    expect(segments(text)[0]).toMatchObject({ kind: "region", label: "````", lines: LONG + 4 });
    expect(segments(text)[1]).toEqual({ kind: "text", text: "after\n" });
  });

  it("does not close a section at its closing tag inside a code block", () => {
    const code = "```xml\n<example>\n</example>\n" + lines(LONG) + "```\n";
    const text = `<example>\n${code}</example>\n`;
    const [section] = segments(text);
    expect(section).toMatchObject({ kind: "region", label: "<example>", lines: LONG + 6, close: "</example>\n" });
    expect((section as { body: Segment[] }).body).toMatchObject([{ kind: "region", line: 1, label: "```xml", close: "```\n" }]);
    expect(joined(segments(text))).toBe(text);
  });

  it("closes a section quoting another of its name at its own closing tag", () => {
    const quoted = `<system-reminder>\n${lines(LONG)}</system-reminder>\n`;
    const text = `<system-reminder>\n${quoted}after\n</system-reminder>\n`;
    const [section, ...rest] = segments(text);
    expect(rest).toEqual([]);
    expect(section).toMatchObject({ kind: "region", line: 0, lines: LONG + 5, body: [{ kind: "region", line: 1 }, { kind: "text", text: "after\n" }] });
    expect(joined(segments(text))).toBe(text);
  });

  it("opens and closes sections only at tags starting a line, not at tags mentioned within one", () => {
    const text = `<system-reminder>\nMention: the <system-reminder> tag, closed by </system-reminder>.\n${lines(LONG)}</system-reminder>\n`;
    expect(segments(text)).toMatchObject([{ kind: "region", line: 0, lines: LONG + 3 }]);
  });

  it("takes a backtick line with a backtick in its info string as code inline, not a fence", () => {
    const text = "```js```\n" + lines(LONG + 1);
    expect(segments(text)).toEqual([{ kind: "text", text }]);
  });

  it("names a region by its opening line, which stays its line when a section around it closes", () => {
    const open = "<analysis>\n```py\n" + lines(LONG) + "```\n";
    expect(segments(open)).toMatchObject([{ kind: "text", text: "<analysis>\n" }, { kind: "region", line: 1 }]);
    expect(segments(open + "</analysis>\n")).toMatchObject([{ kind: "region", line: 0, body: [{ kind: "region", line: 1 }] }]);
  });
});
