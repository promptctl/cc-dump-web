import { describe, expect, it } from "vitest";
import { LONG, segments, type Segment } from "./regions.ts";

const lines = (count: number, word = "line") => Array.from({ length: count }, (_, i) => `${word} ${i}\n`).join("");

// The text a list of segments shows when every region is expanded.
const joined = (list: Segment[]): string => list.map((segment) => (segment.kind === "text" ? segment.text : segment.open + joined(segment.body) + segment.close)).join("");

describe("segments", () => {
  it("finds a long fenced code block and keeps its body as code", () => {
    const code = "```ts\n" + lines(LONG, "<b>") + "```\n";
    const text = `Before.\n${code}After.`;
    expect(segments(text)).toEqual([
      { kind: "text", text: "Before.\n" },
      { kind: "region", label: "```ts", lines: LONG + 2, open: "```ts\n", body: [{ kind: "text", text: lines(LONG, "<b>") }], close: "```\n" },
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
    expect(segments(text)).toEqual([{ kind: "region", label: "```py", lines: LONG + 1, open: "```py\n", body: [{ kind: "text", text: lines(LONG) }], close: "" }]);
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
});
