import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";
import { readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - cross-day-chip, tray-save-message
 * - day-grid data-scroll-hour (restored on cancel)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

async function liftTowardStrip(page: import("@playwright/test").Page, project: string) {
  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, project, start.x, start.y, start.x, stripBox.y + 14, 420);
  return { start, stripBox };
}

test("release over the strip before and after the dwell, on the tray, pointercancel", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const before = await readCalendar(page);
  const vendor = before.blocks.find((row) => row.title === "Call vendor");
  if (!vendor) throw new Error("vendor");
  const grid = page.getByTestId("day-grid");
  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  const origin = await page.getByRole("heading", { level: 1 }).innerText();

  const { stripBox } = await liftTowardStrip(page, testInfo.project.name);
  await touchDrag(page, testInfo.project.name, stripBox.x + 200, stripBox.y + 8, stripBox.x + 200, stripBox.y + 8, 0);
  await expect(page.getByTestId("tray-save-message")).toHaveCount(0);
  expect((await readCalendar(page)).blocks.find((row) => row.id === vendor.id)?.starts_at).toBe(vendor.starts_at);

  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu");
  await touchDrag(page, testInfo.project.name, thuBox.x + 10, thuBox.y + 10, thuBox.x + 10, thuBox.y + 10, 500);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  await touchDrag(page, testInfo.project.name, stripBox.x + 120, stripBox.y + 8, stripBox.x + 120, stripBox.y + 8, 0);
  await expect(page.getByRole("heading", { name: origin })).toBeVisible();
  expect(await grid.getAttribute("data-scroll-hour")).toBeTruthy();

  await liftTowardStrip(page, testInfo.project.name);
  await touchDrag(page, testInfo.project.name, thuBox.x + 10, thuBox.y + 10, thuBox.x + 10, thuBox.y + 10, 500);
  const tray = page.locator(".v3-tray");
  const trayBox = await tray.boundingBox();
  if (!trayBox) throw new Error("tray");
  await touchDrag(page, testInfo.project.name, trayBox.x + 40, trayBox.y + 6, trayBox.x + 40, trayBox.y + 6, 0);
  await expect(page.getByRole("heading", { name: origin })).toBeVisible();

  await liftTowardStrip(page, testInfo.project.name);
  await touchDrag(page, testInfo.project.name, thuBox.x + 10, thuBox.y + 10, thuBox.x + 10, thuBox.y + 10, 500);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, pointerId: 1 }));
  });
  await expect(page.getByRole("heading", { name: origin })).toBeVisible();
  expect(await grid.evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, -1);
  expect((await readCalendar(page)).blocks.find((row) => row.id === vendor.id)?.starts_at).toBe(vendor.starts_at);
});
