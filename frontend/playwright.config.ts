import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendDir, "..");
const e2eDir = process.env.TAFO_E2E_DIR ?? path.join(os.tmpdir(), "tafo-playwright");
const dbPath = path.join(e2eDir, "tafo.sqlite");
const apiPort = "8787";
const webPort = "4173";

function pythonBin(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

const browserEnv = {
  ...process.env,
  TAFO_E2E_DIR: e2eDir,
  TAFO_DATA_DIR: e2eDir,
  TAFO_DB_PATH: dbPath,
  TAFO_CALENDAR_MODE: "demo",
  TAFO_SEED_DEMO: "0",
  TAFO_DISPLAY_TIMEZONE: "America/Indianapolis",
  TAFO_HOST: "127.0.0.1",
  TAFO_PORT: apiPort,
  TAFO_ALLOW_LAN: "0",
  TAFO_HUMAN_EDITS_AUTO_APPROVE: "1",
  TAFO_GOOGLE_CREDENTIALS_FILE: "",
  TAFO_GOOGLE_CALENDAR_ID: "",
  TAFO_WORK_INVITE_EMAIL: "",
  TAFO_E2E: "1",
  PYTHONUNBUFFERED: "1",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(repoRoot, "test-results"),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(repoRoot, "playwright-report") }],
    ["json", { outputFile: path.join(repoRoot, "playwright-report", "results.json") }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "phone",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: [
    {
      command: `"${pythonBin()}" scripts/e2e_server.py`,
      cwd: repoRoot,
      env: browserEnv,
      url: `http://127.0.0.1:${apiPort}/api/meta`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npm run preview -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: frontendDir,
      env: {
        ...process.env,
        TAFO_API_PROXY: `http://127.0.0.1:${apiPort}`,
      },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
