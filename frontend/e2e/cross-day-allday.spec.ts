import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - all-day-row
 * - block-{id} data-draggable="0" for multi-day spans
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("dwell on Thu with an all-day item, drop anywhere on the grid", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const allDay = page.getByTestId("all-day-row").getByRole("button", { name: /Team offsite/i });
  await expect(allDay).toBeVisible();
  const before = await readCalendar(page);
  const event = before.blocks.find((row) => row.title.includes("Team offsite"));
  if (!event) throw new Error("all-day event missing");

  const at = await center(allDay);
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, testInfo.project.name, at.x, at.y, stripBox.x + 150, stripBox.y + 10, 420);
  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu");
  await touchDrag(page, testInfo.project.name, thuBox.x + 16, thuBox.y + 10, thuBox.x + 16, thuBox.y + 10, 500);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();

  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  await touchDrag(page, testInfo.project.name, gridBox.x + 50, gridBox.y + 500, gridBox.x + 50, gridBox.y + 500, 0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("all-day-row")).toContainText("Team offsite");

  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("tray-save-message"),
    includes: [/Team offsite → Thu/i],
    blocks: [{ id: event.id, starts_at: event.starts_at }],
  });

  const multi = page.getByRole("button", { name: /Conference.*Nov 9.*Nov 11/i });
  await expect(multi).toHaveAttribute("data-draggable", "0");
  const multiAt = await center(multi);
  await touchDrag(page, testInfo.project.name, multiAt.x, multiAt.y, multiAt.x, multiAt.y + 10, 420);
  await expect(page.getByRole("heading", { name: /Conference/ })).toBeVisible();
});
