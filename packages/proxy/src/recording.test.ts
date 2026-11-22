import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createWriter, recordedLength, splitLines } from "./recording.ts";

// A directory removed when the test finishes, and a path in it.
function pathOf(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

describe("recordedLength", () => {
  it.each([
    ["an empty file", "", { terminated: 0, unterminated: 0 }],
    ["whole lines", '{"a":1}\n{"b":2}\n', { terminated: 16, unterminated: 0 }],
    ["a cut line after whole ones", '{"a":1}\n{"b":', { terminated: 8, unterminated: 5 }],
    ["a cut first line", '{"a":', { terminated: 0, unterminated: 5 }],
    // A cut line longer than the block the end of the file is read back in.
    ["a cut line longer than one block", `{"a":1}\n{"b":"${"x".repeat(100_000)}`, { terminated: 8, unterminated: 100_006 }],
  ])("measures %s as the bytes through the last newline, and the bytes after it", (_what, text, measured) => {
    const path = pathOf("a.jsonl");
    writeFileSync(path, text);
    expect(recordedLength(path)).toEqual(measured);
  });

  it("measures a file that is not there as none, which is not an empty file", () => {
    expect(recordedLength(pathOf("a.jsonl"))).toBeUndefined();
  });

  it("fails on a file it cannot read, rather than measuring it as empty", () => {
    const path = pathOf("a.jsonl");
    mkdirSync(path);
    expect(() => recordedLength(path)).toThrow(/EISDIR/);
  });
});

describe("splitLines", () => {
  it("splits on the newline byte alone, with the offset just past each line, and leaves the bytes after the last", () => {
    // A carriage return and a byte that is no UTF-8 stay inside their line: lines are never decoded.
    const bytes = Buffer.concat([Buffer.from('{"a":"x\r'), Buffer.from([0xff]), Buffer.from('"}\n{"b":2}\n{"c"')]);
    const { lines, rest } = splitLines(bytes, 100);
    expect(lines.map(({ line, end }) => [line.length, end])).toEqual([
      [11, 112],
      [7, 120],
    ]);
    expect(rest.toString()).toBe('{"c"');
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

  it("creates a file that is not there at its first write, and never one that was there when it was made", () => {
    const missing = pathOf("a.jsonl");
    createWriter(missing).append(Buffer.from('{"a":1}\n'));
    expect(readFileSync(missing, "utf8")).toBe('{"a":1}\n');

    const made = pathOf("b.jsonl");
    writeFileSync(made, "");
    const writer = createWriter(made);
    rmSync(made);
    expect(() => writer.append(Buffer.from('{"a":1}\n'))).toThrow(/ENOENT/);
    expect(existsSync(made)).toBe(false);
  });

  it("cuts a fragment a failed write left after its last whole event, at its next write", () => {
    const path = pathOf("a.jsonl");
    const writer = createWriter(path);
    writer.append(Buffer.from('{"a":1}\n'));
    appendFileSync(path, '{"b":');

    writer.append(Buffer.from('{"c":3}\n'));

    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"c":3}\n');
    expect(writer.written()).toBe(16);
  });
});
