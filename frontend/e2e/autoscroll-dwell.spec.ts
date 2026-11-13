import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";

/**
 * v4 testids:
 * - autoscroll-zone-top, autoscroll-zone-bottom
 * - day-strip (top zone sits below the strip)
 * - next-day-link (bottom zone stops at midnight)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("pass-through to strip never scrolls; 400 ms dwell scrolls", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch autoscroll");

  const grid = page.getByTestId("day-grid");
  const topZone = page.getByTestId("autoscroll-zone-top");
  const bottomZone = page.getByTestId("autoscroll-zone-bottom");
  await expect(topZone).toBeVisible();
  await expect(bottomZone).toBeVisible();

  const scroll0 = await grid.evaluate((node) => node.scrollTop);
  const vendor = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");

  await touchDrag(page, testInfo.project.name, vendor.x, vendor.y, vendor.x, stripBox.y + 4, 420);
  expect(await grid.evaluate((node) => node.scrollTop)).toBe(scroll0);

  const topBox = await topZone.boundingBox();
  if (!topBox) throw new Error("top zone missing");
  await touchDrag(page, testInfo.project.name, vendor.x, vendor.y, vendor.x, topBox.y + topBox.height / 2, 420);
  await page.waitForTimeout(450);
  expect(await grid.evaluate((node) => node.scrollTop)).toBeLessThan(scroll0);

  await grid.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const atBottom = await grid.evaluate((node) => node.scrollTop);
  await touchDrag(page, testInfo.project.name, vendor.x, vendor.y, vendor.x, atBottom, 420);
  const bottomBox = await bottomZone.boundingBox();
  if (!bottomBox) throw new Error("bottom zone missing");
  await touchDrag(page, testInfo.project.name, vendor.x, atBottom, vendor.x, bottomBox.y + 2, 420);
  await page.waitForTimeout(450);
  const afterDwell = await grid.evaluate((node) => node.scrollTop);
  expect(afterDwell).toBeGreaterThanOrEqual(atBottom);
  await expect(page.getByTestId("next-day-link")).toBeInViewport();
});
