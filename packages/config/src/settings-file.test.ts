import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, value } from "@cc-dump/log/json";
import { settingsFile } from "./settings-file.ts";

type Test = { name: string; count: number };
const readers = { name: value(kinds.string), count: value(kinds.integer) };
const file = settingsFile<Test>("test settings", readers, { name: "none", count: 1 });

it("writes the settings where none were, so they read back as written, leaving no other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cc-dump/test.json");
  file.write(path, { name: "first", count: 1 });
  file.write(path, { name: "second", count: 2 });
  expect(file.read(path)).toEqual({ settings: { name: "second", count: 2 }, file_keys: ["name", "count"], unread: [] });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name: "second", count: 2 });
  expect(readdirSync(join(dir, "cc-dump"))).toEqual(["test.json"]);
});

it("reads a setting the file leaves out as its default", () => {
  expect(file.parse('{"name":"only"}')).toEqual({ settings: { name: "only", count: 1 }, file_keys: ["name"], unread: [] });
  expect(file.parse(undefined)).toEqual({ settings: { name: "none", count: 1 }, file_keys: null, unread: [] });
});

it("reads a file holding keys this build does not read, naming each, `__proto__` included", () => {
  expect(file.parse('{"name":"a","colour":"red","__proto__":{"count":5}}')).toEqual({
    settings: { name: "a", count: 1 },
    file_keys: ["name", "colour", "__proto__"],
    unread: [
      { at: ["colour"], why: "is not read by this build, which reads name, count" },
      { at: ["__proto__"], why: "is not read by this build, which reads name, count" },
    ],
  });
});

it("refuses a value of a key it reads that does not fit, naming the key and the file, as Malformed", () => {
  expect(() => file.parse('{"count":"2","name":3}')).toThrow(Malformed);
  expect(() => file.parse('{"count":"2","name":3}')).toThrow("test settings: name: is not a string; count: is not an integer");
  expect(() => file.parse("[1]")).toThrow("test settings: is not an object");
  expect(() => file.parse("{")).toThrow(/^test settings: is not JSON/);
});

it("fails as it is declared with a default its reader refuses, or one no reader reads", () => {
  expect(() => settingsFile<Test>("test settings", readers, { name: 1, count: 1 })).toThrow("test settings defaults: name: is not a string");
  expect(() => settingsFile<Test>("test settings", readers, { name: "a", count: 1, extra: true } as never)).toThrow(
    "test settings defaults: extra: is not read by this build, which reads name, count",
  );
  expect(() => settingsFile<Test>("test settings", readers, { name: "a", count: 1 })).not.toThrow();
});
