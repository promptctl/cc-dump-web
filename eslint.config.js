import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", ".claude/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // [LAW:single-enforcer] A part is a client of anything and serves only through @cc-dump/log's serve,
    // which logs every request, connection error and bind. An allowlist of client calls, so a server
    // constructor node adds later is refused too; a type binds nothing.
    files: ["packages/*/**/*.{ts,tsx}"],
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
              message: "A part serves HTTP only through serve from @cc-dump/log.",
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
);
