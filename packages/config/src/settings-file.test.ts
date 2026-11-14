import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { settingsFile } from "./settings-file.ts";

const file = settingsFile("test settings", {
  name: { default: "none", parse: (value: unknown) => String(value) },
  count: { default: 1, parse: (value: unknown) => Number(value) },
});

it("writes the settings where none were, so they read back as written, leaving no other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cc-dump/test.json");
  file.write(path, { name: "first", count: 1 });
  file.write(path, { name: "second", count: 2 });
  expect(file.read(path)).toEqual({ settings: { name: "second", count: 2 }, file_keys: ["name", "count"] });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name: "second", count: 2 });
  expect(readdirSync(join(dir, "cc-dump"))).toEqual(["test.json"]);
});
