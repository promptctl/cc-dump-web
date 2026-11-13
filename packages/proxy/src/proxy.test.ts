import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

it("answers every request with 501 until forwarding exists", async () => {
  const proxy = createProxy(() => {});
  await new Promise<void>((resolve) => proxy.listen(0, resolve));
  const { port } = proxy.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
  await res.text();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));

  expect(res.status).toBe(501);
});
