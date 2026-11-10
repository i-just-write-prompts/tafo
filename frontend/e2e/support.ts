import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shotRoot = path.join(repoRoot, "review-screenshots");

/** Tuesday 10 Nov 2026, 10:40 in America/Indianapolis. */
export const FIXTURE_NOW = Date.parse("2026-11-10T15:40:00Z");

export async function reseed(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/e2e/reset");
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { db?: string };
  expect(body.db, "e2e database path").toBeTruthy();
  expect(body.db ?? "").not.toMatch(/data[\\/]tafo\.sqlite$/);
}

export async function openDay(page: Page): Promise<void> {
  await page.addInitScript((fixed: number) => {
    const RealDate = Date;
    const started = RealDate.now();
    const shiftedNow = () => fixed + (RealDate.now() - started);
    function ShiftedDate(this: Date, ...args: ConstructorParameters<DateConstructor>) {
      if (!(this instanceof ShiftedDate)) {
        return args.length === 0 ? new RealDate(shiftedNow()) : new RealDate(...args);
      }
      return args.length === 0 ? new RealDate(shiftedNow()) : new RealDate(...args);
    }
    ShiftedDate.prototype = RealDate.prototype;
    ShiftedDate.now = shiftedNow;
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    window.Date = ShiftedDate as DateConstructor;
  }, FIXTURE_NOW);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await expect(page.getByTestId("view-switch")).toContainText("Day");
  await expect(page.getByTestId("day-grid")).toBeVisible();
}

export async function press(locator: Locator, projectName: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  if (projectName === "phone") await locator.tap();
  else await locator.click();
}

export async function shot(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dir = path.join(shotRoot, testInfo.project.name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`${testInfo.project.name}-${slug}`, { path: file, contentType: "image/png" });
}

export function block(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(title) }).first();
}

/** Press-and-hold, then move. The hold is what lifts a block. */
export async function dragHold(page: Page, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.waitForTimeout(420);
  await page.mouse.move(toX, toY, { steps: 16 });
  await page.mouse.up();
}

export async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing box");
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 18) };
}
