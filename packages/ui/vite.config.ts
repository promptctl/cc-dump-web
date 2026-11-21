import { LOOPBACK, UI_PORT } from "@cc-dump/log/address";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: LOOPBACK, port: UI_PORT, strictPort: true },
});
