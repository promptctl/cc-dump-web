import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { expect, it, onTestFinished } from "vitest";

// The proxy as `pnpm dev` starts it, its config and data homes in a fresh directory. A settings file it cannot take
// stops it before it binds a port, so this runs beside a proxy already listening on the fixed ones.
it("reads its settings from cc-dump/proxy.json under the XDG config home, and does not start on one it cannot take", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "config/cc-dump"), { recursive: true });
  const path = join(home, "config/cc-dump/proxy.json");
  writeFileSync(path, '{"port":0}');

  const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };
  const child = spawn(process.execPath, [new URL("./main.ts", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "ignore"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  const [out, [code]] = await Promise.all([text(child.stdout), once(child, "exit")]);

  expect(code).toBe(1);
  expect(out.trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
    expect.objectContaining({ event: "settings", path, config_home_from: "XDG_CONFIG_HOME", outcome: "error", error: expect.stringContaining("port must be an integer from 1 to 65535, got 0") }),
  ]);
});
