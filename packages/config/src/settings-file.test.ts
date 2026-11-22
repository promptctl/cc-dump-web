import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { settingsFile } from "./settings-file.ts";
import { parseSettings } from "./settings.ts";

const table = {
  name: { default: "none", parse: (value: unknown) => String(value) },
  count: { default: 1, parse: (value: unknown) => Number(value) },
};
const file = settingsFile("test settings", table);

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

it("refuses a message's settings missing one, where a file's is its default", () => {
  expect(file.parse('{"name":"only"}').settings).toEqual({ name: "only", count: 1 });
  expect(() => parseSettings("test message", table, { name: "only" })).toThrow("test message: count missing");
});

it("refuses what it cannot take as Malformed, and passes a setting's parse's own bug as it is", () => {
  expect(() => parseSettings("test message", table, { name: "only", count: 1, other: 2 })).toThrow(Malformed);
  const odd = {
    name: {
      default: "none",
      parse: () => {
        throw new Malformed("name is odd");
      },
    },
  };
  expect(() => parseSettings("test message", odd, { name: "x" })).toThrow(Malformed);
  const bug = new TypeError("not a function");
  const buggy = {
    name: {
      default: "none",
      parse: () => {
        throw bug;
      },
    },
  };
  expect(() => parseSettings("test message", buggy, { name: "x" })).toThrow(bug);
});
