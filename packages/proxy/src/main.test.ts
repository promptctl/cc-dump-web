import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { serve } from "@cc-dump/log";
import { expect, it, onTestFinished } from "vitest";

// The proxy as `pnpm dev` starts it, its config and data homes in a fresh directory, its settings file holding `settings`.
function proxyWith(settings: string) {
  const home = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "config/cc-dump"), { recursive: true });
  const path = join(home, "config/cc-dump/proxy.json");
  writeFileSync(path, settings);

  const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };
  const child = spawn(process.execPath, [new URL("./main.ts", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "ignore"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  return { child, path };
}

// A settings file it cannot take stops it before it binds a port, so this runs beside a proxy already listening.
it("reads its settings from cc-dump/proxy.json under the XDG config home, and does not start on one it cannot take", async () => {
  const { child, path } = proxyWith('{"port":0}');
  const [out, [code]] = await Promise.all([text(child.stdout), once(child, "exit")]);

  expect(code).toBe(1);
  expect(out.trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
    expect.objectContaining({ event: "settings", path, config_home_from: "XDG_CONFIG_HOME", outcome: "error", error: expect.stringContaining("port must be an integer from 1 to 65535, got 0") }),
  ]);
});

// The port agents are pointed at is bound before the reader port, so its listen event is written even beside a proxy
// already holding the reader port.
it("listens for agents on the port its settings file sets", async () => {
  // A free port: one the system gave, let go of again.
  const free = await serve(() => {}, () => {}, 0);
  await free.close();
  const { port } = free;

  const { child, path } = proxyWith(JSON.stringify({ port, upstream: "http://127.0.0.1:9/gateway" }));
  const events: Record<string, unknown>[] = [];
  for await (const line of createInterface({ input: child.stdout })) {
    events.push(JSON.parse(line) as Record<string, unknown>);
    if (events.at(-1)!.event === "listen") break;
  }

  expect(events.find(({ event }) => event === "settings")).toMatchObject({
    path,
    outcome: "ok",
    file_keys: ["port", "upstream"],
    port,
    upstream: "http://127.0.0.1:9/gateway",
  });
  expect(events.at(-1)).toMatchObject({ event: "listen", outcome: "ok", requested_port: port, port });
});
