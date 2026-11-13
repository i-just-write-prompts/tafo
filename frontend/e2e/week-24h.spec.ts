import { expect, test } from "@playwright/test";

import { openDay, openWeek, press, reseed, shot, skipUnlessTouch, touchSwipe } from "./support";

/**
 * v4 testids (integration):
 * - week-grid: data-range="24h", data-hour-count
 * - week-hour-axis: synchronized scroll rail
 * - week-column: one per weekday, data-scroll-synced="1"
 * - hour-row: data-hour, data-repeated (DST), data-skipped (spring forward)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("week scrolls 12 AM–12 AM, columns stay aligned", async ({ page }, testInfo) => {
  await openWeek(page, testInfo.project.name);
  const grid = page.getByTestId("week-grid");
  await expect(grid).toHaveAttribute("data-range", "24h");
  await expect(grid).toHaveAttribute("data-hour-count", /^(24|25|23)$/);

  const midnight = page.getByTestId("hour-row-0");
  const endRow = page.getByTestId("hour-row-last");
  await expect(midnight).toContainText(/12.*AM/i);
  await expect(endRow).toBeVisible();

  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  const maxScroll = await grid.evaluate((node) => node.scrollHeight - node.clientHeight);
  await grid.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollBefore + maxScroll * 0.4);

  const columns = page.locator('[data-testid^="week-column-"]');
  await expect(columns).toHaveCount(7);
  const tops = await columns.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).scrollTop));
  expect(new Set(tops).size).toBe(1);

  await shot(page, testInfo, "week-24h-bottom");
});

test("DST fall-back week keeps seven aligned columns with a 25-hour day", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch week navigation");

  await openWeek(page, testInfo.project.name);
  const grid = page.getByTestId("week-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("week grid missing");
  const y = box.y + box.height / 2;
  for (let swipe = 0; swipe < 8; swipe += 1) {
    const heading = await page.getByRole("heading", { level: 1 }).innerText();
    if (heading.includes("Nov 1") || heading.includes("Oct 26")) break;
    await touchSwipe(page, testInfo.project.name, box.x + box.width - 24, y, box.x + 24, y);
  }

  const repeated = page.getByTestId("hour-row-1am-repeated");
  await expect(repeated).toBeVisible();
  await expect(repeated).toContainText(/again/i);
  await expect(grid).toHaveAttribute("data-hour-count", "25");

  await press(page.getByRole("radio", { name: /Sun/ }), testInfo.project.name);
  const sunCol = page.getByTestId("week-column-sun");
  await expect(sunCol).toHaveAttribute("data-dst-hours", "25");
  await shot(page, testInfo, "week-dst-fallback");
});
