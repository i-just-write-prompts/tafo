import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";

/**
 * v4 testids:
 * - strip-dwell-ring, strip-cell-origin-highlight
 * - cross-day-reentry-hint (title row copy)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("on Thu, dwell on Fri, then back to the origin", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");

  async function dwellOn(testId: string) {
    const cell = page.getByTestId(testId);
    const box = await cell.boundingBox();
    if (!box) throw new Error(testId);
    await touchDrag(page, testInfo.project.name, box.x + box.width / 2, box.y + 10, box.x + box.width / 2, box.y + 10, 500);
    return cell;
  }

  await touchDrag(page, testInfo.project.name, start.x, start.y, stripBox.x + 120, stripBox.y + 12, 420);
  await dwellOn("strip-cell-thu");
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();

  await touchDrag(page, testInfo.project.name, start.x, stripBox.y + 40, start.x, stripBox.y + 12, 120);
  await expect(page.getByTestId("strip-dwell-ring")).toHaveAttribute("data-progress", "0");

  await touchDrag(page, testInfo.project.name, start.x, stripBox.y + 12, start.x, stripBox.y + 12, 120);
  await dwellOn("strip-cell-fri");
  await expect(page.getByRole("heading", { name: "Fri, Nov 13" })).toBeVisible();

  const tue = await dwellOn("strip-cell-tue");
  await expect(tue.getByTestId("strip-cell-origin-highlight")).toBeVisible();
  await expect(page.getByTestId("cross-day-reentry-hint")).toContainText(/hold Tue to open/i);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();

  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  await touchDrag(page, testInfo.project.name, start.x, gridBox.y + 360, start.x, gridBox.y + 360, 0);
  await expect(page.getByTestId("tray-save-message")).toHaveCount(0);
  await expect(block(page, "Call vendor,")).toHaveAttribute("aria-label", /11:00|10:00/);
});
