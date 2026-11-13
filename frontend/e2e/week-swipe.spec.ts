import { expect, test } from "@playwright/test";

import { openDay, openWeek, reseed, skipUnlessTouch, touchSwipe } from "./support";

/**
 * v4 testids:
 * - week-pager: data-offset-px, data-committing
 * - week-grid: data-scroll-hour (preserved across page)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("swipe pages ±1 week, settles or springs back", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch paging");

  await openWeek(page, testInfo.project.name);
  const grid = page.getByTestId("week-grid");
  const pager = page.getByTestId("week-pager");
  await expect(pager).toHaveAttribute("data-enabled", "1");

  const scrollHour = await grid.getAttribute("data-scroll-hour");
  await grid.evaluate((node) => {
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.35);
  });
  const scrollAfterScroll = await grid.evaluate((node) => node.scrollTop);
  expect(scrollAfterScroll).toBeGreaterThan(40);

  const beforeTitle = await page.getByRole("heading", { level: 1 }).innerText();
  const box = await grid.boundingBox();
  if (!box) throw new Error("week grid missing");
  const y = box.y + 120;

  const started = Date.now();
  await touchSwipe(page, testInfo.project.name, box.x + box.width - 20, y, box.x + 20, y, 0);
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(beforeTitle, { timeout: 2_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThanOrEqual(300 + 500);

  await expect(grid).toHaveAttribute("data-scroll-hour", scrollHour ?? "");

  const partialX = Math.round(box.width * 0.18);
  await touchSwipe(page, testInfo.project.name, box.x + 30, y, box.x + 30 + partialX, y, 0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(beforeTitle);
  await expect(pager).toHaveAttribute("data-offset-px", "0");
});
