import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, object, parse, parsed, value, type Reader } from "@cc-dump/log/json";
import { settingsFile } from "./settings-file.ts";
import { settings } from "./settings.ts";

const table = {
  name: { default: "none", read: value(kinds.string) },
  count: { default: 1, read: value(kinds.integer) },
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
  expect(() => parse(settings(table), { name: "only" }, "test message")).toThrow("test message: count: is missing");
});

it("refuses a key a file sets that is no setting, at any depth, naming the file and its path", () => {
  const nested = settingsFile("test settings", { window: { default: { width: 80 }, read: object({ width: value(kinds.integer) }) } });
  expect(() => file.parse('{"name":"only","nmae":"x"}')).toThrow("test settings: nmae: is not read by this build");
  expect(() => nested.parse('{"window":{"width":80,"hieght":24}}')).toThrow("test settings: window: hieght: is not read by this build");
});

it("refuses what it cannot take as Malformed, and passes a setting's reader's own bug as it is", () => {
  const odd = { name: { default: "none", read: parsed(kinds.string, (): string => { throw new Malformed("is odd"); }) } };
  expect(() => settingsFile("test settings", odd).parse('{"name":"x"}')).toThrow(new Malformed("test settings: name: is odd"));
  const bug = new TypeError("not a function");
  const buggy: Reader<string> = () => {
    throw bug;
  };
  expect(() => settingsFile("test settings", { name: { default: "none", read: buggy } }).parse('{"name":"x"}')).toThrow(bug);
});
