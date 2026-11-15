import { LOOPBACK } from "@cc-dump/log/address";
import { serving } from "@cc-dump/log/testing";
import { expect, it } from "vitest";
import { fetchProxyInfo, requestRecording } from "./proxy.ts";

it("reads what the proxy says it is", async () => {
  const { port } = await serving((_req, res) => res.end('{"base_url":"http://127.0.0.1:3344","upstream":"https://api.anthropic.com/"}'));
  expect(await fetchProxyInfo(port)).toEqual({ base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/" });
});

it("fails, naming what it asked, when nothing answers in time", async () => {
  // Something on the reader port that takes the request and never answers it.
  const { port } = await serving(() => {});
  await expect(fetchProxyInfo(port, 50)).rejects.toMatchObject({ message: `GET http://${LOOPBACK}:${port}/info`, cause: { name: "TimeoutError" } });
});

it("asks the proxy to make a recording, and reads the one it made", async () => {
  const asked: string[] = [];
  const { port } = await serving((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.end('{"name":"20261114T010203.004Z.jsonl"}');
  });
  expect(await requestRecording(port)).toEqual({ name: "20261114T010203.004Z.jsonl" });
  expect(asked).toEqual(["POST /recordings"]);
});

it("fails, naming what it asked, when the proxy refuses to make one", async () => {
  const { port } = await serving((_req, res) => res.writeHead(500).end());
  await expect(requestRecording(port)).rejects.toMatchObject({ message: `POST http://${LOOPBACK}:${port}/recordings`, cause: { message: expect.stringContaining("500") } });
});
