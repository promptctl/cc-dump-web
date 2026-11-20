import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";

// Each Messages request of a recording, one JSON line each, in the order they arrived: its trace, the `x-claude-code-*`
// headers its head carries, and its body, decoded. `node packages/ui/check/requests.ts <recording.jsonl>`, for reading
// what Claude Code sends with jq or grep (docs/design/claude-code-wire.md). A request is printed once its body is whole.
const recording = process.argv[2];
if (recording === undefined) throw new Error("Give the recording to read: node packages/ui/check/requests.ts <recording.jsonl>");
const requests = new Map<string, { headers: [string, string][]; body: Buffer[] }>();
for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) {
  if (line === "") continue;
  const event = JSON.parse(line) as RecordedEvent;
  const request = requests.get(event.trace_id) ?? { headers: [], body: [] };
  requests.set(event.trace_id, request);
  if (event.type === "request") request.headers = event.headers.filter(([name]) => name.toLowerCase().startsWith("x-claude-code-")).map(([name, value]) => [name.toLowerCase(), value]);
  if (event.type === "request_body") request.body.push(Buffer.from(event.base64, "base64"));
  if (event.type !== "request_trailers" && event.type !== "end") continue;
  if (request.body.length === 0) continue;
  const text = Buffer.concat(request.body).toString("utf8");
  request.body = [];
  const body: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      console.error(`${event.trace_id}: its body is not whole JSON, ${text.length} characters`);
      return undefined;
    }
  })();
  if (typeof body === "object" && body !== null && "messages" in body) console.log(JSON.stringify({ trace: event.trace_id, headers: request.headers, body }));
}
