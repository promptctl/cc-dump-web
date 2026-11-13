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
    files: ["packages/ui/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { "react-refresh": reactRefresh },
    rules: {
      // A module that exports anything besides components forces a full page reload instead of HMR.
      "react-refresh/only-export-components": "error",
    },
  },
);
