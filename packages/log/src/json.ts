// [LAW:single-enforcer] The one parse of JSON text into a JSON object, for every part's messages (each part's format.ts)
// and settings files (@cc-dump/config) alike, each failure naming `what` was read. Imports nothing that needs node, so
// the UI's parsers use it too.

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what}: is not JSON`, { cause: error });
  }
}

export function jsonObject(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${what}: is not an object`);
  return json as Record<string, unknown>;
}
