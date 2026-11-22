import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, parsed, value } from "@cc-dump/log/json";
import { settingsFile } from "./settings-file.ts";

type Test = { name: string; count: number };
const file = settingsFile<Test>("test settings", { readers: { name: value(kinds.string), count: value(kinds.integer) }, defaults: { name: "none", count: 1 } });

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

it("takes a setting the file leaves out as its default", () => {
  expect(file.parse('{"name":"only"}').settings).toEqual({ name: "only", count: 1 });
});

it("refuses a key it does not read, naming it and the settings there are, and a value it cannot take, naming its setting", () => {
  expect(() => file.parse('{"name":"only","cuont":2}')).toThrow(Malformed);
  expect(() => file.parse('{"name":"only","cuont":2}')).toThrow("test settings: cuont: is not read by this build, which reads name, count");
  expect(() => file.parse('{"count":"2"}')).toThrow("test settings: count: is not an integer");
});

it("passes a setting's reader's own bug as it is", () => {
  const bug = new TypeError("not a function");
  const buggy = settingsFile<{ name: string }>("test settings", {
    readers: {
      name: parsed(kinds.string, () => {
        throw bug;
      }),
    },
    defaults: { name: "none" },
  });
  expect(() => buggy.parse(undefined)).toThrow(bug);
});
