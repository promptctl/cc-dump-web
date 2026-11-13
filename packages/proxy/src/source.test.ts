import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { sha256 } from "./source.ts";

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-dump-source-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("recordSource", () => {
  it("records each file node loads after it, with the SHA-256 of its text, and itself", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "first.ts"), 'import { second } from "./second.ts";\nexport const first: string = second;\n');
    writeFileSync(join(dir, "second.ts"), 'export const second: string = "second";\n');
    const script = `
      import { recordSource } from ${JSON.stringify(new URL("./source.ts", import.meta.url).href)};
      const recording = recordSource();
      await import(${JSON.stringify(join(dir, "first.ts"))});
      process.stdout.write(JSON.stringify([...recording.loaded()]));
    `;
    const recorded = new Map(JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })) as [string, string][]);
    const own = fileURLToPath(new URL("./source.ts", import.meta.url));
    expect(recorded).toEqual(
      new Map([own, join(dir, "first.ts"), join(dir, "second.ts")].map((path) => [path, sha256(readFileSync(path))])),
    );
  });
});
