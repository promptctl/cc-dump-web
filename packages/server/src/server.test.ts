import { serveForTest } from "@cc-dump/log/testing";
import { expect, it } from "vitest";
import { app } from "./server.ts";

it("answers an unknown route with 404", async () => {
  const port = await serveForTest(() => {}, app);

  const res = await fetch(`http://127.0.0.1:${port}/api/nothing`);
  await res.text();

  expect(res.status).toBe(404);
});
