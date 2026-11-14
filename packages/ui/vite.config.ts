import { LOOPBACK } from "@cc-dump/log/address";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { UI_PORT } from "./src/address.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: LOOPBACK, port: UI_PORT, strictPort: true },
});
