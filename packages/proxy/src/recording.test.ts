import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createWriter, recordedLength } from "./recording.ts";

// A directory removed when the test finishes, and a path in it.
function pathOf(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

describe("recordedLength", () => {
  it.each([
    ["no file", undefined, { terminated: 0, unterminated: 0 }],
    ["an empty file", "", { terminated: 0, unterminated: 0 }],
    ["whole lines", '{"a":1}\n{"b":2}\n', { terminated: 16, unterminated: 0 }],
    ["a cut line after whole ones", '{"a":1}\n{"b":', { terminated: 8, unterminated: 5 }],
    ["a cut first line", '{"a":', { terminated: 0, unterminated: 5 }],
    // A cut line longer than the block the end of the file is read back in.
    ["a cut line longer than one block", `{"a":1}\n{"b":"${"x".repeat(100_000)}`, { terminated: 8, unterminated: 100_006 }],
  ])("measures %s as the bytes through the last newline, and the bytes after it", (_what, text, measured) => {
    const path = pathOf("a.jsonl");
    if (text !== undefined) writeFileSync(path, text);
    expect(recordedLength(path)).toEqual(measured);
  });

  it("fails on a file it cannot read, rather than measuring it as empty", () => {
    const path = pathOf("a.jsonl");
    mkdirSync(path);
    expect(() => recordedLength(path)).toThrow(/EISDIR/);
  });
});

describe("createWriter", () => {
  it("starts after the last whole line of a file already at its path, so a crash's fragment is cut, never glued to the next event", () => {
    const path = pathOf("a.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":');
    const writer = createWriter(path);

    expect(writer.written()).toBe(8);
    writer.append(Buffer.from('{"c":3}\n'));

    expect(recordedLength(path)).toEqual({ terminated: 16, unterminated: 0 });
    expect(writer.written()).toBe(16);
  });
});
