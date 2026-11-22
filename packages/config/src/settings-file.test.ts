import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, object, parse, parsed, value } from "@cc-dump/log/json";
import { settingsFile } from "./settings-file.ts";
import { settings } from "./settings.ts";

const table = {
  name: { default: "none", read: value(kinds.string) },
  count: { default: 1, read: value(kinds.integer) },
  window: { default: { width: 80 }, read: object({ width: value(kinds.integer) }) },
};
const file = settingsFile("test settings", table);

it("writes the settings where none were, so they read back as written, leaving no other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cc-dump/test.json");
  file.write(path, { name: "first", count: 1, window: { width: 80 } });
  file.write(path, { name: "second", count: 2, window: { width: 100 } });
  expect(file.read(path)).toEqual({ settings: { name: "second", count: 2, window: { width: 100 } }, file_keys: ["name", "count", "window"] });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name: "second", count: 2, window: { width: 100 } });
  expect(readdirSync(join(dir, "cc-dump"))).toEqual(["test.json"]);
});

it("reads a setting a file leaves out as its default, and refuses a message's settings missing one", () => {
  expect(file.parse('{"name":"only"}').settings).toEqual({ name: "only", count: 1, window: { width: 80 } });
  expect(() => parse(settings(table), { name: "only", window: { width: 80 } }, "test message")).toThrow("test message: count: is missing");
});

it("refuses a field no setting reads, at any depth, naming the file, its path and what is read there", () => {
  expect(() => file.parse('{"name":"only","nmae":"x","window":{"width":80,"hieght":2}}')).toThrow(
    "test settings: nmae: is not read here; read here: name, count, window; window: hieght: is not read here; read here: width",
  );
});

it("refuses a value its setting cannot take as Malformed, naming it, and passes a read's own bug as it is", () => {
  expect(() => file.parse('{"count":"two"}')).toThrow("test settings: count: is not an integer");
  expect(() => file.parse('{"count":"two"}')).toThrow(Malformed);
  const bug = new TypeError("not a function");
  const buggy = {
    name: {
      default: "none",
      read: parsed(kinds.string, () => {
        throw bug;
      }),
    },
  };
  expect(() => settingsFile("buggy settings", buggy)).toThrow(bug);
});

it("refuses a default its own setting cannot take, as the file is made", () => {
  expect(() => settingsFile("odd settings", { count: { default: "one", read: value(kinds.integer) } })).toThrow("odd settings's defaults: count: is not an integer");
});
