import { readFileSync } from "node:fs";
import { jsonObject, parseJson } from "./json.ts";
import { parseUpstream } from "./proxy.ts";

// [LAW:parse-dont-validate] [LAW:one-source-of-truth] The proxy's settings (docs/design/01-mvp.md, F11), each with its
// default, written as the file would hold it and parsed the same way: `port`, the port agents are pointed at, and
// `upstream`, the address it forwards to. A setting added here is read, defaulted and refused by everything below.
const settings = {
  port: {
    default: 3344,
    parse: (value: unknown) => {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535)
        throw new Error(`port must be an integer from 1 to 65535, got ${JSON.stringify(value)}`);
      return value as number;
    },
  },
  upstream: { default: "https://api.anthropic.com", parse: parseUpstream },
};

export type ProxySettings = { [K in keyof typeof settings]: ReturnType<(typeof settings)[K]["parse"]> };

// The settings read, and where they came from: `file_keys` is null when there is no file, else the settings the file
// set; every other setting is its default.
export type ReadSettings = { settings: ProxySettings; file_keys: string[] | null };

// [LAW:no-silent-failure] `text` is the file's, or undefined when there is no file. A value the proxy cannot take is
// refused, naming it, never read as its default: the proxy would listen or forward somewhere the user did not set. So
// is a key it does not know, which is most often a setting misspelled.
export function parseProxySettings(text: string | undefined): ReadSettings {
  const file = text === undefined ? {} : jsonObject(parseJson(text, "proxy settings"), "proxy settings");
  const unknown = Object.keys(file).filter((key) => !Object.hasOwn(settings, key));
  if (unknown.length > 0)
    throw new Error(`proxy settings: no setting is named ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the settings are ${Object.keys(settings).join(", ")}`);
  const taken = Object.entries(settings).map(([key, setting]) => [key, setting.parse(Object.hasOwn(file, key) ? file[key] : setting.default)]);
  return { settings: Object.fromEntries(taken) as ProxySettings, file_keys: text === undefined ? null : Object.keys(file) };
}

// Read once, at the proxy's start: a change to the file takes effect when the proxy restarts.
export function readProxySettings(path: string): ReadSettings {
  return parseProxySettings(fileText(path));
}

function fileText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
