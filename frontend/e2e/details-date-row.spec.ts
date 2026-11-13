import { expect, test } from "@playwright/test";

import { block, openDay, press, reseed } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - details-date-row (opens month-grid-sheet)
 * - month-grid-sheet, month-grid-cell-{dayKey}
 * - details-time-row (optional follow-up edit path)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("date row opens grid sheet, one-write move, tray message", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const vendor = before.blocks.find((row) => row.title === "Call vendor");
  if (!vendor) throw new Error("vendor");

  await press(block(page, "Call vendor,"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Call vendor" })).toBeVisible();
  const dateRow = page.getByTestId("details-date-row");
  await expect(dateRow).toBeVisible();
  await press(dateRow, testInfo.project.name);
  await expect(page.getByTestId("month-grid-sheet")).toBeVisible();

  await press(page.getByTestId("month-grid-cell-2026-11-12"), testInfo.project.name);
  await expect(page.getByTestId("month-grid-sheet")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();

  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("tray-save-message"),
    includes: ["Call vendor → Thu 2 PM"],
    blocks: [{ id: vendor.id, starts_at: "2026-11-12T19:00:00Z", ends_at: "2026-11-12T19:30:00Z" }],
  });
  await expect(page.getByTestId("details-sheet")).toHaveCount(0);
});
