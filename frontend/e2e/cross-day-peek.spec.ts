import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - strip-dwell-ring, strip-cell-{dow}, strip-drop-hint-{dow}
 * - cross-day-chip, gutter-drag-pill, cross-day-marker
 * - cross-day-target-dot, tray-save-message
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("dwell 450 ms on Thu, place at 2 PM, settle, return to Tue", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const before = await readCalendar(page);
  const vendor = before.blocks.find((row) => row.title === "Call vendor");
  if (!vendor) throw new Error("vendor missing");

  const originHeading = "Tue, Nov 10";
  await expect(page.getByRole("heading", { name: originHeading })).toBeVisible();
  const grid = page.getByTestId("day-grid");
  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");

  await touchDrag(page, testInfo.project.name, start.x, start.y, start.x, stripBox.y + 18, 420);
  await expect(page.getByTestId("cross-day-chip")).toBeVisible();

  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu cell");
  await touchDrag(page, testInfo.project.name, thuBox.x + thuBox.width / 2, thuBox.y + 12, thuBox.x + thuBox.width / 2, thuBox.y + 12, 500);
  await expect(thu.getByTestId("strip-dwell-ring")).toHaveAttribute("data-progress", "1");
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  await expect(page.getByTestId("cross-day-marker")).toContainText(/from Tue/i);

  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  const twoPmY = gridBox.y + 360;
  await touchDrag(page, testInfo.project.name, start.x, stripBox.y + 20, start.x, twoPmY, 200);
  await touchDrag(page, testInfo.project.name, start.x, twoPmY, start.x, twoPmY, 0);

  await page.waitForTimeout(350);
  await expect(page.getByRole("button", { name: /Call vendor.*Thu/ })).toBeVisible();
  await expect(page.getByTestId("tray-save-message")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: originHeading })).toBeVisible({ timeout: 5_000 });
  expect(await grid.evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, -1);

  const message = page.getByTestId("tray-save-message");
  await expect(message).toContainText("Call vendor → Thu 2 PM");
  await expect(page.getByTestId("cross-day-target-dot-thu")).toBeVisible();

  await checkSaveClaim(page, {
    case: "matches-server",
    toast: message,
    includes: ["Call vendor → Thu 2 PM"],
    blocks: [{ id: vendor.id, starts_at: "2026-11-12T19:00:00Z", ends_at: "2026-11-12T19:30:00Z" }],
  });
});
