import { expect, test } from "@playwright/test";

import { block, center, openDay, press, reseed, skipUnlessTouch, touchDrag, touchSwipe } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - hour-row-1am-repeated, gutter-drag-pill
 * - cross-day-marker
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("peek Sun Nov 1, drop in the '1 AM · again' row", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day DST");

  const before = await readCalendar(page);
  const vendor = before.blocks.find((row) => row.title === "Call vendor");
  if (!vendor) throw new Error("vendor");

  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, testInfo.project.name, start.x, start.y, stripBox.x + 40, stripBox.y + 12, 420);

  const targetCell = page.getByTestId("strip-cell-2026-11-01");
  for (let attempt = 0; attempt < 6 && (await targetCell.count()) === 0; attempt += 1) {
    const weekStrip = page.getByTestId("week-strip");
    const weekBox = await weekStrip.boundingBox();
    if (!weekBox) throw new Error("week strip");
    await touchSwipe(page, testInfo.project.name, weekBox.x + weekBox.width - 12, weekBox.y + 10, weekBox.x + 12, weekBox.y + 10, 0);
  }
  const sun = targetCell;
  const sunBox = await sun.boundingBox();
  if (!sunBox) throw new Error("sun");
  await touchDrag(page, testInfo.project.name, sunBox.x + 12, sunBox.y + 10, sunBox.x + 12, sunBox.y + 10, 500);
  await expect(page.getByRole("heading", { name: /Sun.*Nov 1/ })).toBeVisible();
  await expect(page.getByTestId("cross-day-marker")).toContainText(/from Tue/i);

  const repeated = page.getByTestId("hour-row-1am-repeated");
  await expect(repeated).toContainText(/again/i);
  const rowBox = await repeated.boundingBox();
  if (!rowBox) throw new Error("repeated hour");
  await touchDrag(page, testInfo.project.name, start.x, rowBox.y + 20, start.x, rowBox.y + 30, 120);
  await expect(page.getByTestId("gutter-drag-pill")).toContainText(/1:30.*AM/i);
  await touchDrag(page, testInfo.project.name, start.x, rowBox.y + 28, start.x, rowBox.y + 28, 0);

  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible({ timeout: 5_000 });
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("tray-save-message"),
    includes: ["→ Sun 1:30 AM"],
    blocks: [{ id: vendor.id, starts_at: "2026-11-01T06:30:00.000Z" }],
  });

  const undo = page.getByTestId("tray-save-message").getByRole("button", { name: "Undo" });
  await press(undo, testInfo.project.name);
  expect((await readCalendar(page)).blocks.find((row) => row.id === vendor.id)?.starts_at).toBe(vendor.starts_at);
});
