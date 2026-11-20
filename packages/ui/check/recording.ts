import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";

// What a recording's file holds, an event at a time, in the order the proxy wrote them, so a check of a recording
// larger than memory holds none of it but what it keeps. [LAW:no-silent-failure] A line that is not JSON stops the read,
// naming the recording and the line.
export async function* eventsOf(recording: string): AsyncGenerator<{ event: RecordedEvent; where: string }> {
  let number = 0;
  for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) {
    number++;
    if (line === "") continue;
    const where = `${recording}:${number}`;
    yield { event: parsed<RecordedEvent>(line, where), where };
  }
}

// `text` parsed as JSON, or an error naming `where` it came from.
export function parsed<T>(text: string, where: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${where}: not JSON: ${(error as Error).message}`, { cause: error });
  }
}
