import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shotRoot = path.join(repoRoot, "review-screenshots");

/** Wednesday of the fixture week, 11:00 in America/Indianapolis. */
const FIXTURE_NOW = Date.parse("2026-11-04T16:00:00Z");
export const FIXTURE_RANGE = "Mon Nov 2 \u2013 Sun Nov 8";

export async function reseed(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/e2e/reset");
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { db?: string };
  expect(body.db, "e2e database path").toBeTruthy();
  expect(body.db ?? "").not.toMatch(/data[\\/]tafo\.sqlite$/);
}

export async function openFixtureWeek(page: Page): Promise<void> {
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
    // The plan anchors the week on `new Date()` once, at first render.
    window.Date = ShiftedDate as DateConstructor;
  }, FIXTURE_NOW);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "TAFO" })).toBeVisible();
  await expect(page.getByText(FIXTURE_RANGE)).toBeVisible();
  await expect(page.getByTestId("cal-grid")).toBeVisible();
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

export function proposal(page: Page, title: string): Locator {
  return page.locator("[data-testid^='proposed-']").filter({ hasText: title });
}

export function blockFace(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped},`) });
}

export async function dragBetween(page: Page, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  try {
    await page.mouse.move(toX, toY, { steps: 20 });
  } finally {
    await page.mouse.up();
  }
}

export async function columnDropPoint(page: Page, dayKey: string): Promise<{ x: number; y: number }> {
  const column = page.getByTestId(`cal-column-${dayKey}`);
  await column.scrollIntoViewIfNeeded();
  const scrollBox = await page.locator(".cal-scroll").boundingBox();
  const colBox = await column.boundingBox();
  if (!scrollBox || !colBox) throw new Error(`missing column geometry for ${dayKey}`);
  const x = colBox.x + colBox.width / 2;
  const top = Math.max(scrollBox.y + 8, colBox.y);
  const bottom = Math.min(scrollBox.y + scrollBox.height - 8, colBox.y + colBox.height);
  const y = top + Math.max(24, (bottom - top) / 2);
  return { x, y };
}

export async function placeBlockInView(page: Page, block: Locator): Promise<void> {
  await block.evaluate((element) => {
    const scroller = element.closest(".cal-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const blockBox = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    scroller.scrollTop += blockBox.top - view.top - 12;
  });
}
