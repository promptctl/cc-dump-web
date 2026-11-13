import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createAppServer } from "./server.ts";

it("answers an unknown route with 404", async () => {
  const server = createAppServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/api/nothing`);
  await res.text();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(res.status).toBe(404);
});
