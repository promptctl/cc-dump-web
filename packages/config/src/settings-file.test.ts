import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, orElse, parsed, value } from "@cc-dump/log/json";
import { settingsFile } from "./settings-file.ts";

type Test = { name: string; count: number };
const file = settingsFile<Test>("test settings", { name: value(kinds.string), count: value(kinds.integer) }, { name: "none", count: 1 });

const dir = () => {
  const made = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(made, { recursive: true, force: true }));
  return made;
};

it("writes the settings where none were, so they read back as written, leaving no other file", () => {
  const made = dir();
  const path = join(made, "cc-dump/test.json");
  file.write(path, { name: "first", count: 1 });
  file.write(path, { name: "second", count: 2 });
  expect(file.read(path)).toEqual({ settings: { name: "second", count: 2 }, file_keys: ["name", "count"], unknown_keys: [] });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name: "second", count: 2 });
  expect(readdirSync(join(made, "cc-dump"))).toEqual(["test.json"]);
});

it("reads a file holding keys no setting is named, naming each, the rest at their defaults", () => {
  expect(file.parse('{"name":"only","colour":"blue","__proto__":{"count":9}}')).toEqual({
    settings: { name: "only", count: 1 },
    file_keys: ["name", "colour", "__proto__"],
    unknown_keys: ["colour", "__proto__"],
  });
});

it("refuses to write a change its next read would refuse, leaving the file as it was", () => {
  const path = join(dir(), "test.json");
  file.write(path, { name: "kept", count: 2 });
  expect(() => file.write(path, { count: 1.5 })).toThrow(/^test settings in .*, as changed: count: is not an integer$/);
  expect(file.read(path).settings).toEqual({ name: "kept", count: 2 });
});

it("refuses a value a setting's reader would replace by a fallback, naming the key, never reading it as the fallback", () => {
  const lenient = settingsFile<Test>("test settings", { name: value(kinds.string), count: orElse(value(kinds.integer), 1) }, { name: "none", count: 1 });
  expect(() => lenient.parse('{"count":"many"}')).toThrow(/^test settings: count: is not an integer$/);
});

it("refuses a value of a key it reads that does not fit, naming the key and the file", () => {
  expect(() => file.read(join(dir(), "absent.json"))).not.toThrow();
  const path = join(dir(), "test.json");
  writeFileSync(path, '{"name":"x","count":"2"}');
  expect(() => file.read(path)).toThrow(Malformed);
  expect(() => file.read(path)).toThrow(`test settings in ${path}: count: is not an integer`);
});

it("keeps every key of the file a write does not set, another build's included, and refuses to write over a file that is no JSON object", () => {
  const path = join(dir(), "test.json");
  writeFileSync(path, '{"name":"x","colour":"blue","count":3}');
  file.write(path, { name: "y" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name: "y", colour: "blue", count: 3 });
  writeFileSync(path, "[1]");
  expect(() => file.write(path, { name: "z" })).toThrow(`test settings in ${path}: is not an object`);
  expect(readFileSync(path, "utf8")).toBe("[1]");
});

it("fails as it is declared when its reader refuses a default, and passes a reader's own bug as it is", () => {
  expect(() => settingsFile<Test>("odd settings", { name: value(kinds.string), count: value(kinds.integer) }, { name: "none", count: "one" })).toThrow(
    "odd settings's defaults: count: is not an integer",
  );
  const bug = new TypeError("not a function");
  const buggy = parsed(kinds.string, () => {
    throw bug;
  });
  expect(() => settingsFile<{ name: string }>("buggy settings", { name: buggy }, { name: "x" })).toThrow(bug);
});
