import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function revision(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const apiProxy = process.env.TAFO_API_PROXY ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  define: {
    __TAFO_REV__: JSON.stringify(revision()),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiProxy,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": apiProxy,
    },
  },
});
