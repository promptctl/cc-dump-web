import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxySettings, readProxySettings } from "./settings.ts";

describe("parseProxySettings", () => {
  it("reads no file as every setting's default, and says there was none", () => {
    expect(parseProxySettings(undefined)).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: null });
  });

  it("takes each setting the file sets, the rest their defaults, and says which the file set", () => {
    expect(parseProxySettings("{}")).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: [] });
    expect(parseProxySettings('{"port":3400}')).toEqual({ settings: { port: 3400, upstream: "https://api.anthropic.com/" }, file_keys: ["port"] });
    expect(parseProxySettings('{"upstream":"http://127.0.0.1:8080/anthropic","port":3400}')).toEqual({
      settings: { port: 3400, upstream: "http://127.0.0.1:8080/anthropic" },
      file_keys: ["upstream", "port"],
    });
  });

  it.each([
    ['{"port":"3400"}', 'port must be an integer from 1 to 65535, got "3400"'],
    ['{"port":0}', "port must be an integer from 1 to 65535, got 0"],
    ['{"port":65536}', "port must be an integer from 1 to 65535, got 65536"],
    ['{"port":3400.5}', "port must be an integer from 1 to 65535, got 3400.5"],
    ['{"port":null}', "port must be an integer from 1 to 65535, got null"],
    ['{"upstream":1}', "upstream must be a string, got 1"],
    ['{"upstream":"https://gw.example/?key=1"}', 'upstream must be an http or https origin with an optional path, got "https://gw.example/?key=1"'],
    ['{"prot":3400}', 'proxy settings: "prot" is not a setting; the settings are port, upstream'],
    ["port = 3400", "proxy settings: is not JSON"],
    ["[3400]", "proxy settings: is not an object"],
    ["null", "proxy settings: is not an object"],
  ])("refuses %s, naming why, rather than taking a default the user did not set", (text, reason) => {
    expect(() => parseProxySettings(text)).toThrow(reason);
  });
});

describe("readProxySettings", () => {
  const dir = () => {
    const made = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(made, { recursive: true, force: true }));
    return made;
  };

  it("reads a missing file as no file", () => {
    expect(readProxySettings(join(dir(), "proxy.json")).file_keys).toBeNull();
  });

  it("reads the file's settings", () => {
    const path = join(dir(), "proxy.json");
    writeFileSync(path, '{"port":3400}');
    expect(readProxySettings(path).settings.port).toBe(3400);
  });

  it("throws a file it cannot read", () => {
    const path = join(dir(), "proxy.json");
    mkdirSync(path);
    expect(() => readProxySettings(path)).toThrow("EISDIR");
  });
});
