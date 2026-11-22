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
    expect(parseProxySettings(undefined)).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: null, unread: [] });
  });

  it("takes each setting the file sets, the rest their defaults, and says which the file set", () => {
    expect(parseProxySettings("{}")).toEqual({ settings: { port: 3344, upstream: "https://api.anthropic.com/" }, file_keys: [], unread: [] });
    expect(parseProxySettings('{"port":3400}')).toEqual({ settings: { port: 3400, upstream: "https://api.anthropic.com/" }, file_keys: ["port"], unread: [] });
    expect(parseProxySettings('{"upstream":"http://127.0.0.1:8080/anthropic","port":3400}')).toEqual({
      settings: { port: 3400, upstream: "http://127.0.0.1:8080/anthropic" },
      file_keys: ["upstream", "port"],
      unread: [],
    });
  });

  it("reads a file holding keys this build does not read, a newer build's or one misspelled, and names each", () => {
    expect(parseProxySettings('{"prot":3400,"port":3401,"upstrem":""}')).toEqual({
      settings: { port: 3401, upstream: "https://api.anthropic.com/" },
      file_keys: ["prot", "port", "upstrem"],
      unread: [
        { at: ["prot"], why: "is not read by this build, which reads port, upstream" },
        { at: ["upstrem"], why: "is not read by this build, which reads port, upstream" },
      ],
    });
  });

  it.each([
    ['{"port":"3400"}', "proxy settings: port: is not an integer from 1 to 65535"],
    ['{"port":0}', "proxy settings: port: is not an integer from 1 to 65535"],
    ['{"port":65536}', "port: is not an integer from 1 to 65535"],
    ['{"port":3400.5}', "port: is not an integer from 1 to 65535"],
    ['{"port":null}', "port: is not an integer from 1 to 65535"],
    ['{"upstream":1}', "proxy settings: upstream: is not a string"],
    ['{"upstream":"https://gw.example/?key=1"}', "proxy settings: upstream: is not an http or https origin with an optional path"],
    ['{"port":0,"upstream":1,"other":true}', "proxy settings: port: is not an integer from 1 to 65535; upstream: is not a string"],
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
