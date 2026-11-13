import { expect, test } from "@playwright/test";

import { block, center, dragHold, openDay, openWeek, press, reseed, skipUnlessTouch, touchDrag, touchSwipe } from "./support";

/**
 * v4 testids:
 * - plan-banner (existing): unchanged during pager
 * - day-title-jump, month-grid-sheet, month-grid-cell-{dayKey}
 */

test.beforeEach(async ({ page, request }, testInfo) => {
  await reseed(request);
  await openDay(page);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toBeVisible();
});

test("swipe and jump keep plan banner and staged moves", async ({ page }, testInfo) => {
  const vendor = await center(block(page, "Call vendor,"));
  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");

  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  expect(staged?.moves?.length).toBe(1);

  test.skip(skipUnlessTouch(testInfo.project.name), "touch paging");

  const grid = page.getByTestId("day-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("day grid missing");
  await touchSwipe(page, testInfo.project.name, box.x + box.width - 16, box.y + 180, box.x + 16, box.y + 180, 0);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");

  await press(page.getByTestId("day-title-jump"), testInfo.project.name);
  await expect(page.getByTestId("month-grid-sheet")).toBeVisible();
  await press(page.getByTestId("month-grid-cell-2026-11-12"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"))?.moves?.[0]?.id).toBe(
    staged.moves[0].id,
  );

  await openWeek(page, testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  const weekGrid = page.getByTestId("week-grid");
  const weekBox = await weekGrid.boundingBox();
  if (!weekBox) throw new Error("week grid missing");
  await touchSwipe(page, testInfo.project.name, weekBox.x + weekBox.width - 12, weekBox.y + 140, weekBox.x + 12, weekBox.y + 140, 0);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
});

test("cross-day peek in plan mode returns to the origin view", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const vendor = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");
  await touchDrag(page, testInfo.project.name, vendor.x, vendor.y, vendor.x, stripBox.y + stripBox.height / 2, 420);
  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu cell missing");
  await touchDrag(page, testInfo.project.name, thuBox.x + thuBox.width / 2, thuBox.y + 8, thuBox.x + thuBox.width / 2, thuBox.y + 8, 500);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  await expect(page.getByTestId("cross-day-marker")).toContainText(/from Tue/i);

  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid missing");
  await touchDrag(page, testInfo.project.name, gridBox.x + 120, gridBox.y + 360, gridBox.x + 120, gridBox.y + 360, 0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("plan-banner")).toContainText(/Thu.*2.*PM|Tue.*→.*Thu/i);
});
