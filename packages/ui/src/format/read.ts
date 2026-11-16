// The reading of a JSON value as the shape its reader needs, and the Misfit when it is not that shape.

// A JSON value that is not the shape its reader needs.
export class Misfit extends Error {}

// `format()`, or, when what it reads does not fit, `misfit` with why. [LAW:no-silent-failure] The callers show a value
// that does not fit as raw, with the reason, so a shape the API changes is seen, not dropped.
export function fitting<T>(format: () => T, misfit: (reason: string) => T): T {
  try {
    return format();
  } catch (error) {
    if (!(error instanceof Misfit)) throw error;
    return misfit(error.message);
  }
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Misfit(`${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// [LAW:parse-dont-validate] The fields of a JSON object, each read as the type it must have or a Misfit naming it, and
// the fields no read asked for: those are shown as they are, so a field the API adds is never dropped.
export function readObject(value: unknown, what: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Misfit(`${what} is not an object`);
  const object = value as Record<string, unknown>;
  const read = new Set<string>();
  const field = (name: string) => {
    read.add(name);
    return object[name];
  };
  const fits = <T>(name: string, is: (value: unknown) => value is T, expected: string): T => {
    const value = field(name);
    if (!is(value)) throw new Misfit(`${what}'s ${name} is not ${expected}`);
    return value;
  };
  return {
    value: field,
    string: (name: string) => fits(name, (value) => typeof value === "string", "a string"),
    optionalString: (name: string) => fits(name, (value) => value === undefined || typeof value === "string", "a string, if present"),
    array: (name: string) => fits(name, Array.isArray, "a list"),
    rest: (): Record<string, unknown> => Object.fromEntries(Object.entries(object).filter(([name]) => !read.has(name))),
  };
}
export type Fields = ReturnType<typeof readObject>;
