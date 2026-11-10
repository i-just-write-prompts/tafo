/**
 * Drive the built v3 UI and save phone frames plus two short clips.
 * Run from the repo root after `npm run build` in frontend/.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium, webkit } = createRequire(path.join(root, "frontend/package.json"))("@playwright/test");

const out = path.join(root, "docs", "v3-build");
const frames = path.join(out, "phone");
const s23 = path.join(out, "s23-360x668");
const clips = path.join(out, "clips");
let shotDir = frames;
const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), "tafo-v3-capture-"));
const python = fs.existsSync(path.join(root, ".venv", "bin", "python"))
  ? path.join(root, ".venv", "bin", "python")
  : "python3";
const NOW = Date.parse("2026-11-10T15:40:00Z");

fs.mkdirSync(frames, { recursive: true });
fs.mkdirSync(s23, { recursive: true });
fs.mkdirSync(clips, { recursive: true });

function start(cmd, args, env, cwd = root) {
  return spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
}

const api = start(python, ["scripts/e2e_server.py"], {
  TAFO_E2E_DIR: e2eDir,
  TAFO_DATA_DIR: e2eDir,
  TAFO_DB_PATH: path.join(e2eDir, "tafo.sqlite"),
  TAFO_CALENDAR_MODE: "demo",
  TAFO_SEED_DEMO: "0",
  TAFO_DISPLAY_TIMEZONE: "America/Indianapolis",
  TAFO_HOST: "127.0.0.1",
  TAFO_PORT: "8791",
  TAFO_ALLOW_LAN: "0",
  TAFO_HUMAN_EDITS_AUTO_APPROVE: "1",
  TAFO_E2E: "1",
});
const web = start("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4179", "--strictPort"], {
  TAFO_API_PROXY: "http://127.0.0.1:8791",
}, path.join(root, "frontend"));

async function waitFor(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
}

async function drag(page, fromX, fromY, toX, toY, { release = true, picture = null } = {}) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.waitForTimeout(420);
  await page.mouse.move(toX, toY, { steps: 18 });
  if (picture) {
    await page.waitForTimeout(120);
    await shot(page, picture);
  }
  if (release) await page.mouse.up();
  await page.waitForTimeout(200);
}

async function center(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing box");
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 16) };
}

async function open(page, frame) {
  await page.addInitScript(({ fixed, frame }) => {
    const RealDate = Date;
    const started = RealDate.now();
    const shiftedNow = () => fixed + (RealDate.now() - started);
    function ShiftedDate(...args) {
      if (!(this instanceof ShiftedDate)) {
        return args.length ? new RealDate(...args) : new RealDate(shiftedNow());
      }
      return args.length ? new RealDate(...args) : new RealDate(shiftedNow());
    }
    ShiftedDate.prototype = RealDate.prototype;
    ShiftedDate.now = shiftedNow;
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    window.Date = ShiftedDate;
    const mark = () => {
      if (frame && document.documentElement) document.documentElement.dataset.frame = "1";
    };
    mark();
    document.addEventListener("DOMContentLoaded", mark);
    window.__tafoNow = new Date().toISOString();
  }, { fixed: NOW, frame });
  await page.goto("http://127.0.0.1:4179/");
  try {
    await page.getByRole("heading", { name: "Tue, Nov 10" }).waitFor({ timeout: 15_000 });
  } catch (error) {
    const text = await page.locator("body").innerText().catch(() => "");
    const probe = await page.evaluate(() => ({ now: window.__tafoNow, frame: document.documentElement.dataset.frame, date: new Date().toISOString() })).catch((err) => String(err));
    console.error("PROBE", probe);
    console.error("PAGE TEXT:", text.slice(0, 500));
    await page.screenshot({ path: path.join(frames, "debug.png") }).catch(() => undefined);
    throw error;
  }
}

async function columnX(page, dayIndex) {
  const grid = page.getByTestId("week-grid");
  const box = await grid.boundingBox();
  const gutter = Number(await grid.getAttribute("data-gutter"));
  const column = (box.width - gutter - 2) / 7;
  return box.x + gutter + column * dayIndex + column / 2;
}

try {
  await waitFor("http://127.0.0.1:8791/api/health");
  await waitFor("http://127.0.0.1:4179/");
  const browser = await webkit.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("PAGE ERROR", error.message));
  page.on("console", (message) => console.log("CONSOLE", message.type(), message.text()));
  await open(page, true);

  await shot(page, "01-day");
  await page.getByTestId("more-button").tap();
  await shot(page, "01b-more-menu");
  await page.getByRole("menuitem", { name: /Show/ }).tap();
  await shot(page, "01c-show");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  const vendor = await center(page.getByRole("button", { name: /Call vendor,/ }));
  await drag(page, vendor.x, vendor.y, vendor.x, vendor.y + 45, { release: false, picture: "02-quick-drag" });
  await page.mouse.move(vendor.x, vendor.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await shot(page, "02b-quick-saved");
  const tip = page.getByRole("button", { name: "Dismiss tip" });
  if (await tip.count()) await tip.tap();
  await page.waitForTimeout(4500);

  await page.getByRole("button", { name: /Budget sheet/ }).tap();
  await shot(page, "03-event-tapped");
  await page.getByRole("button", { name: "Deny", exact: true }).tap();
  await page.waitForTimeout(400);
  await shot(page, "03b-denied");
  await page.waitForTimeout(4200);

  await page.getByTestId("view-switch").tap();
  await page.getByRole("menuitem", { name: "Week" }).tap();
  await page.waitForTimeout(250);
  await shot(page, "04-week");
  await page.getByTestId("plan-button").tap();
  await shot(page, "05-plan-enter");

  const spec = await center(page.getByRole("button", { name: /Spec review/ }));
  await drag(page, spec.x, spec.y, await columnX(page, 2), spec.y);
  const lunch = await center(page.getByRole("button", { name: /Lunch w\/ Sam/ }));
  await drag(page, lunch.x, lunch.y, await columnX(page, 3), lunch.y);
  const gym = await center(page.getByRole("button", { name: /^Gym,/ }));
  const limit = (page.viewportSize()?.height ?? 800) - 36;
  await drag(page, gym.x, gym.y, gym.x, Math.min(gym.y + 190, limit));
  const rosa = await center(page.getByRole("button", { name: /Call Grandma Rosa/ }));
  await drag(page, rosa.x, rosa.y, await columnX(page, 3), rosa.y - 70, { release: false, picture: "06-plan-rearrange" });
  await page.mouse.up();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Review", exact: true }).tap();
  await shot(page, "07-plan-approve");
  await page.getByRole("button", { name: /Approve all/ }).tap();
  await page.waitForTimeout(400);
  await shot(page, "07b-plan-approved");

  await page.request.post("http://127.0.0.1:8791/api/e2e/reset");
  await page.reload();
  await page.getByRole("heading", { name: "Tue, Nov 10" }).waitFor();
  await page.getByTestId("view-switch").tap();
  await page.getByRole("menuitem", { name: "Week" }).tap();
  await page.getByTestId("plan-button").tap();
  const spec2 = await center(page.getByRole("button", { name: /Spec review/ }));
  await drag(page, spec2.x, spec2.y, await columnX(page, 2), spec2.y);
  const lunch2 = await center(page.getByRole("button", { name: /Lunch w\/ Sam/ }));
  await drag(page, lunch2.x, lunch2.y, await columnX(page, 3), lunch2.y);
  await page.getByRole("button", { name: "Revert", exact: true }).tap();
  await shot(page, "08-plan-revert");
  await page.getByRole("button", { name: "Revert all" }).tap();
  await page.waitForTimeout(300);
  await shot(page, "08b-plan-reverted");
  await context.close();

  async function record(name, run) {
    const recording = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
      recordVideo: { dir: clips, size: { width: 390, height: 844 } },
    });
    const clip = await recording.newPage();
    await open(clip, true);
    await run(clip);
    const video = clip.video();
    await recording.close();
    const saved = await video.path();
    fs.copyFileSync(saved, path.join(clips, `${name}.webm`));
  }

  await record("quick-drag", async (clip) => {
    const block = await center(clip.getByRole("button", { name: /Call vendor,/ }));
    await drag(clip, block.x, block.y, block.x, block.y + 60);
    await clip.waitForTimeout(1800);
  });
  await record("plan-mode", async (clip) => {
    await clip.getByTestId("view-switch").tap();
    await clip.getByRole("menuitem", { name: "Week" }).tap();
    await clip.getByTestId("plan-button").tap();
    const first = await center(clip.getByRole("button", { name: /Spec review/ }));
    await drag(clip, first.x, first.y, await columnX(clip, 2), first.y);
    const second = await center(clip.getByRole("button", { name: /Lunch w\/ Sam/ }));
    await drag(clip, second.x, second.y, await columnX(clip, 3), second.y);
    const third = await center(clip.getByRole("button", { name: /^Gym,/ }));
    await drag(clip, third.x, third.y, third.x, third.y + 100);
    await clip.getByRole("button", { name: "Review", exact: true }).tap();
    await clip.waitForTimeout(600);
    await clip.getByRole("button", { name: /Approve all/ }).tap();
    await clip.waitForTimeout(1200);
  });

  await browser.close();

  await fetch("http://127.0.0.1:8791/api/e2e/reset", { method: "POST" });
  const chrome = await chromium.launch();
  const narrow = await chrome.newContext({
    viewport: { width: 360, height: 668 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const phone = await narrow.newPage();
  shotDir = s23;
  await open(phone, false);
  await shot(phone, "01-day");
  await phone.getByTestId("more-button").tap();
  await shot(phone, "01b-more-menu");
  await phone.keyboard.press("Escape");
  const narrowVendor = await center(phone.getByRole("button", { name: /Call vendor,/ }));
  await drag(phone, narrowVendor.x, narrowVendor.y, narrowVendor.x, narrowVendor.y + 45, { release: false, picture: "02-quick-drag" });
  await phone.mouse.move(narrowVendor.x, narrowVendor.y + 60, { steps: 8 });
  await phone.mouse.up();
  await phone.waitForTimeout(400);
  await shot(phone, "02b-quick-saved");
  if (await phone.getByRole("button", { name: "Dismiss tip" }).count()) {
    await phone.getByRole("button", { name: "Dismiss tip" }).tap();
  }
  await phone.keyboard.press("Escape");
  await phone.getByRole("button", { name: /Budget sheet/ }).tap();
  await shot(phone, "03-event-tapped");
  await phone.keyboard.press("Escape");
  await phone.getByTestId("view-switch").tap();
  await shot(phone, "04a-view-switch");
  await phone.getByRole("menuitem", { name: "Week" }).tap();
  await phone.waitForTimeout(250);
  await shot(phone, "04-week");
  await phone.getByTestId("plan-button").tap();
  await shot(phone, "05-plan-enter");
  const narrowSpec = await center(phone.getByRole("button", { name: /Spec review/ }));
  await drag(phone, narrowSpec.x, narrowSpec.y, await columnX(phone, 2), narrowSpec.y, { release: false, picture: "06-plan-rearrange" });
  await phone.mouse.up();
  await narrow.close();
  await chrome.close();
  console.log("captured", frames, s23);
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
}
