import { defineConfig } from "vitest/config";

export default defineConfig({
  // EventSource is behind a flag in node; the UI's connection is tested against the real proxy with it.
  test: { include: ["packages/*/src/**/*.test.{ts,tsx}", "packages/ui/check/**/*.test.ts"], execArgv: ["--experimental-eventsource"] },
});
