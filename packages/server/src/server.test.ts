import { listen } from "@cc-dump/log";
import { expect, it, onTestFinished } from "vitest";
import { createAppServer } from "./server.ts";

it("answers an unknown route with 404", async () => {
  const server = createAppServer(() => {});
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = await listen(() => {}, server, 0);

  const res = await fetch(`http://127.0.0.1:${port}/api/nothing`);
  await res.text();

  expect(res.status).toBe(404);
});
