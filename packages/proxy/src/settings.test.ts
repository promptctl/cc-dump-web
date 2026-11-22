import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as described } from "@cc-dump/log/describe";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxySettings, readProxySettings } from "./settings.ts";

// What `act` refused, as the user is shown it: each error of its chain, outermost first.
function refusal(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return described(error);
  }
  throw new Error("it was not refused");
}

describe("parseProxySettings", () => {
  it("reads no file as every setting's default, and says there was none", () => {
    expect(parseProxySettings(undefined)).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: null, unknown_keys: [] });
  });

  it("takes each setting the file sets, the rest their defaults, and says which the file set", () => {
    expect(parseProxySettings("{}")).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: [], unknown_keys: [] });
    expect(parseProxySettings('{"port":3400}')).toEqual({ settings: { port: 3400, upstream: "https://api.anthropic.com/" }, file_keys: ["port"], unknown_keys: [] });
    expect(parseProxySettings('{"upstream":"http://127.0.0.1:8080/anthropic","port":3400}')).toEqual({
      settings: { port: 3400, upstream: "http://127.0.0.1:8080/anthropic" },
      file_keys: ["upstream", "port"],
      unknown_keys: [],
    });
  });

  it("reads a file holding a key no setting is named, a setting misspelled or another build's, naming it", () => {
    expect(parseProxySettings('{"prot":3400,"port":3401}')).toEqual({ settings: { port: 3401, upstream: "https://api.anthropic.com/" }, file_keys: ["prot", "port"], unknown_keys: ["prot"] });
  });

  it.each([
    ['{"port":"3400"}', "proxy settings: port: is not an integer"],
    ['{"port":0}', "proxy settings: port: is not from 1 to 65535: 0"],
    ['{"port":65536}', "proxy settings: port: is not from 1 to 65535: 65536"],
    ['{"port":3400.5}', "proxy settings: port: is not an integer"],
    ['{"port":null}', "proxy settings: port: is not an integer"],
    ['{"upstream":1}', "proxy settings: upstream: is not a string"],
    ['{"upstream":"https://gw.example/?key=1"}', "proxy settings: upstream: is not an http or https origin with an optional path"],
    ['{"port":"x","upstream":1}', "proxy settings: port: is not an integer; upstream: is not a string"],
    ["port = 3400", "proxy settings: is not JSON"],
    ["[3400]", "proxy settings: is not an object"],
    ["null", "proxy settings: is not an object"],
  ])("refuses %s, naming why, rather than taking a default the user did not set", (text, reason) => {
    expect(refusal(() => parseProxySettings(text))).toContain(reason);
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
