import type { Server } from "node:http";
import { onTestFinished } from "vitest";
import type { Event } from "./index.ts";

// A log the test can wait on: `next()` resolves with the next event written.
export function eventLog() {
  const written: Event[] = [];
  const waiting: ((event: Event) => void)[] = [];
  return {
    log: (event: Event) => {
      const waiter = waiting.shift();
      if (waiter) waiter(event);
      else written.push(event);
    },
    next: () => new Promise<Event>((resolve) => (written.length ? resolve(written.shift()!) : waiting.push(resolve))),
  };
}

export function closedAfterTest(server: Server): Server {
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}
