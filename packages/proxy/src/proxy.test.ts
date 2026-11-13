import { listen } from "@cc-dump/log";
import { expect, it, onTestFinished } from "vitest";
import { createProxy } from "./proxy.ts";

it("answers every request with 501 until forwarding exists", async () => {
  const proxy = createProxy(() => {});
  onTestFinished(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const port = await listen(() => {}, proxy, 0);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
  await res.text();

  expect(res.status).toBe(501);
});
