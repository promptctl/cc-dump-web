import { LOOPBACK } from "@cc-dump/log/address";
import { serving } from "@cc-dump/log/testing";
import { expect, it } from "vitest";
import { fetchProxyInfo } from "./proxy.ts";

it("reads what the proxy says it is", async () => {
  const { port } = await serving((_req, res) => res.end('{"base_url":"http://127.0.0.1:3344"}'));
  expect(await fetchProxyInfo(port)).toEqual({ base_url: "http://127.0.0.1:3344" });
});

it("fails, naming what it asked, when nothing answers in time", async () => {
  // Something on the reader port that takes the request and never answers it.
  const { port } = await serving(() => {});
  await expect(fetchProxyInfo(port, 50)).rejects.toMatchObject({ message: `GET http://${LOOPBACK}:${port}/info`, cause: { name: "TimeoutError" } });
});
