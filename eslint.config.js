import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const network = ["fetch", "EventSource", "WebSocket", "XMLHttpRequest"];
const reachedThroughConnection =
  "The UI reaches the backend only through its Connection (packages/ui/src/connection); the browser's is connection/browser.ts.";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", ".claude/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // [LAW:single-enforcer] A part's code binds no port through node's network modules; it serves through
    // @cc-dump/log's serve, which logs every request, connection error and bind. Its static imports from
    // those modules are limited to the names listed here, so a server constructor node adds later is
    // refused too; a type binds nothing.
    files: ["packages/*/**"],
    ignores: ["packages/log/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(node:)?(http|https|http2|net|tls)$",
              allowImportNamePattern: "^(request|get|connect|createConnection)$",
              allowTypeImports: true,
              message:
                "A part serves HTTP only through serve from @cc-dump/log. A name it needs that binds no port goes on this rule's allowlist in eslint.config.js.",
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
