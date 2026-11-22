// [LAW:single-enforcer] The one parse of JSON text into a JSON object, for every part's messages (each part's format.ts)
// and settings files (@cc-dump/config) alike, each failure naming `what` was read. Imports nothing that needs node, so
// the formats a part shares with the UI use it too.
import { Malformed } from "./failure.ts";

// What JSON text can say: what `JSON.stringify` encodes, and `JSON.parse` gives back, as it was.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Malformed(`${what}: is not JSON`, { cause: error });
  }
}

export function jsonObject(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Malformed(`${what}: is not an object`);
  return json as Record<string, unknown>;
}

// A field of a JSON value read leniently: the value at `name` when `json` is an object, and none otherwise, for a read
// in which a value of any other shape simply holds no such field. `fields` is the strict read.
export function fieldOf(json: unknown, name: string): unknown {
  return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>)[name] : undefined;
}

// A value `read` reads, or JSON's absence, null.
export const nullable =
  <T>(read: (value: unknown, what: string) => T) =>
  (value: unknown, what: string): T | null =>
    value === null ? null : read(value, what);

// The fields of `what`, a JSON object, each read as the JSON type it must have, or an error naming it. `read` takes
// any type a part's format has a test for, and `parsed` any it has a parser for, failing in the parser's words. A parser
// throws `Malformed` for a value it cannot take; any other error is the parser's own bug, and passes as it is.
export function fields(json: unknown, what: string) {
  const object = jsonObject(json, what);
  const read = <T>(name: string, fits: (value: unknown) => value is T, expected: string): T => {
    const value = object[name];
    if (!fits(value)) throw new Malformed(`${what}: ${name} is not ${expected}`);
    return value;
  };
  const parsed = <T>(name: string, parse: (value: unknown) => T): T => {
    try {
      return parse(object[name]);
    } catch (error) {
      throw error instanceof Malformed ? new Malformed(`${what}: ${name}`, { cause: error }) : error;
    }
  };
  return {
    read,
    parsed,
    object: (name: string) => jsonObject(object[name], `${what}: ${name}`),
    string: (name: string) => read(name, (value) => typeof value === "string", "a string"),
    boolean: (name: string) => read(name, (value) => typeof value === "boolean", "a boolean"),
    integer: (name: string) => read(name, Number.isSafeInteger as (value: unknown) => value is number, "an integer"),
    count: (name: string) => read(name, (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0, "a count"),
    oneOf: <T extends string>(name: string, values: Record<T, true>) =>
      read(name, (value): value is T => typeof value === "string" && Object.hasOwn(values, value), `one of ${Object.keys(values).join(", ")}`),
    strings: (name: string) => read(name, (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"), "a list of strings"),
  };
}
