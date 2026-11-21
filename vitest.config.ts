import { defineConfig } from "vitest/config";

export default defineConfig({
  // EventSource is behind a flag in node; the UI's connection is tested against the real proxy with it. A test of what a
  // read lets go of collects garbage itself, which node allows only with `--expose-gc`.
  test: { include: ["packages/*/src/**/*.test.{ts,tsx}", "packages/ui/check/**/*.test.ts"], execArgv: ["--experimental-eventsource", "--expose-gc"] },
});
