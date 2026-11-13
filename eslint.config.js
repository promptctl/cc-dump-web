import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const network = ["fetch", "EventSource", "WebSocket", "XMLHttpRequest"];
// [LAW:single-enforcer] A part's code binds no port through node's network modules; it serves through
// @cc-dump/log's serve, which logs every request, connection error and bind. Its static imports from
// those modules are limited to the names listed here, so a server constructor node adds later is
// refused too; a type binds nothing.
const servesThroughLog = {
  regex: "^(node:)?(http|https|http2|net|tls)$",
  allowImportNamePattern: "^(request|get|connect|createConnection)$",
  allowTypeImports: true,
  message: "A part serves HTTP only through serve from @cc-dump/log. A name it needs that binds no port goes on this rule's allowlist in eslint.config.js.",
};
const reachedThroughConnection =
  "The UI reaches the backend only through its Connection (packages/ui/src/connection); the browser's is connection/browser.ts.";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", ".claude/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["packages/*/**"],
    ignores: ["packages/log/**"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [servesThroughLog] }] },
  },
  {
    // [LAW:one-source-of-truth] The proxy's source is the files node loads after its record begins (source.ts),
    // so the modules that load before it, its entry and source.ts itself, statically import nothing but node's
    // builtins (and the entry, source.ts): a module they imported would run in the proxy unrecorded, and an edit
    // to it would show no restart pending. The rest of the proxy is imported dynamically, once the record has begun.
    files: ["packages/proxy/src/main.ts", "packages/proxy/src/source.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            servesThroughLog,
            {
              regex: "^(?!node:|\\./source\\.ts$)",
              message: "Loads before the proxy's source is recorded: import it dynamically after recordSource (packages/proxy/src/main.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { "react-refresh": reactRefresh },
    rules: {
      // A module that exports anything besides components forces a full page reload instead of HMR.
      "react-refresh/only-export-components": "error",
    },
  },
  {
    // [LAW:single-enforcer] The UI reaches the backend only through its connection: no other UI module knows
    // a backend address or opens a request of its own. The browser connection's test watches the EventSource it opens.
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    ignores: ["packages/ui/src/connection/browser.ts", "packages/ui/src/connection/browser.test.ts"],
    rules: {
      "no-restricted-globals": ["error", ...network.map((name) => ({ name, message: reachedThroughConnection }))],
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis", "self"].flatMap((object) => network.map((property) => ({ object, property, message: reachedThroughConnection }))),
      ],
      "no-restricted-imports": [
        "error",
        // Every part's address module, by package or by path (imports in this repo name their .ts).
        { patterns: [{ group: ["@cc-dump/*/address", "**/address.ts"], message: reachedThroughConnection }] },
      ],
    },
  },
);
