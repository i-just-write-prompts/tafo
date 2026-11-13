import { expect, test } from "@playwright/test";

import { block, center, openDay, press, reseed, skipUnlessTouch, touchDrag } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - cross-day-marker, strip-drop-hint, cross-day-chip
 * - plan-banner, review-sheet (existing)
 */

test.beforeEach(async ({ page, request }, testInfo) => {
  await reseed(request);
  await openDay(page);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
});

test("peek and return stages the move; revert date+time; approve as one write each", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const before = await readCalendar(page);
  const vendor = before.blocks.find((row) => row.title === "Call vendor");
  if (!vendor) throw new Error("Call vendor missing");

  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");
  await touchDrag(page, testInfo.project.name, start.x, start.y, start.x, stripBox.y + 20, 420);
  await expect(page.locator('[data-testid^="strip-drop-hint-"]')).toHaveCount(6);

  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu strip cell missing");
  await touchDrag(page, testInfo.project.name, thuBox.x + thuBox.width / 2, thuBox.y + 8, thuBox.x + thuBox.width / 2, thuBox.y + 8, 500);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();

  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid missing");
  await touchDrag(page, testInfo.project.name, gridBox.x + 80, gridBox.y + 380, gridBox.x + 80, gridBox.y + 380, 0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible({ timeout: 5_000 });

  await expect(page.getByTestId("plan-banner")).toContainText(/Tue.*→.*Thu/i);
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  expect(staged.moves.some((move: { toDayKey?: string }) => move.toDayKey === "2026-11-12")).toBe(true);

  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  const restored = await readCalendar(page);
  expect(restored.blocks.find((row) => row.id === vendor.id)?.starts_at).toBe(vendor.starts_at);

  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await touchDrag(page, testInfo.project.name, start.x, start.y, thuBox.x + thuBox.width / 2, thuBox.y + 8, 520);
  await touchDrag(page, testInfo.project.name, gridBox.x + 80, gridBox.y + 380, gridBox.x + 80, gridBox.y + 380, 0);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);

  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: [/Call vendor → Thu 2 PM/i],
    blocks: [{ id: vendor.id, starts_at: "2026-11-12T19:00:00Z", ends_at: "2026-11-12T19:30:00Z" }],
  });
});

test("proposal across days updates strip markers", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const budget = await center(block(page, "Budget sheet"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");
  await touchDrag(page, testInfo.project.name, budget.x, budget.y, stripBox.x + 40, stripBox.y + 10, 420);
  const fri = page.getByTestId("strip-cell-fri");
  const friBox = await fri.boundingBox();
  if (!friBox) throw new Error("fri missing");
  await touchDrag(page, testInfo.project.name, friBox.x + 16, friBox.y + 10, friBox.x + 16, friBox.y + 10, 500);
  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  await touchDrag(page, testInfo.project.name, gridBox.x + 60, gridBox.y + 300, gridBox.x + 60, gridBox.y + 300, 0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await expect(page.getByTestId("strip-proposal-tue")).toHaveAttribute("data-has-proposals", "0");
  await expect(page.getByTestId("strip-proposal-fri")).toHaveAttribute("data-has-proposals", "1");
});
