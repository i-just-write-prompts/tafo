import { expect, test } from "@playwright/test";

import { block, center, openDay, openWeek, press, reseed, skipUnlessTouch, touchDrag } from "./support";
import { checkSaveClaim, readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - hour-row-1am-repeated (label contains "again")
 * - gutter-drag-pill (during drag)
 * - week-hour-row-folded (week view single 1 AM row)
 */

test.beforeEach(async ({ page, request }, testInfo) => {
  await reseed(request);
  await openDay(page);
  await press(page.getByTestId("day-title-jump"), testInfo.project.name);
  await press(page.getByTestId("month-grid-cell-2026-11-01"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: /Sun.*Nov 1/ })).toBeVisible();
});

test("drop at the second 1:30 AM on Sun Nov 1", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch DST drag");

  const repeatedRow = page.getByTestId("hour-row-1am-repeated");
  await expect(repeatedRow).toContainText(/1 AM.*again/i);
  await expect(page.getByTestId("day-grid")).toHaveAttribute("data-hour-count", "25");

  const before = await readCalendar(page);
  const target = before.blocks.find((row) => row.title === "Evening read") ?? before.blocks[0];
  if (!target) throw new Error("no draggable block on fall-back day");

  const handle = block(page, target.title);
  const at = await center(handle);
  const rowBox = await repeatedRow.boundingBox();
  if (!rowBox) throw new Error("repeated row missing");
  const dropY = rowBox.y + rowBox.height * 0.55;
  await touchDrag(page, testInfo.project.name, at.x, at.y, at.x, dropY, 420);
  await expect(page.getByTestId("gutter-drag-pill")).toContainText(/1:30.*AM/i);

  await touchDrag(page, testInfo.project.name, at.x, dropY, at.x, dropY, 0);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("tray-save-message"),
    includes: ["→ Sun 1:30 AM"],
    blocks: [{ id: target.id, starts_at: "2026-11-01T06:30:00.000Z" }],
  });

  const undo = page.getByTestId("tray-save-message").getByRole("button", { name: "Undo" });
  await press(undo, testInfo.project.name);
  const restored = await readCalendar(page);
  expect(restored.blocks.find((row) => row.id === target.id)?.starts_at).toBe(target.starts_at);
});

test("week folded 1 AM row takes the first 1:30 AM EDT occurrence", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch DST drag");

  await openWeek(page, testInfo.project.name);
  await press(page.getByTestId("day-title-jump"), testInfo.project.name);
  await press(page.getByTestId("month-grid-cell-2026-11-01"), testInfo.project.name);
  const folded = page.getByTestId("week-hour-row-1am-folded");
  await expect(folded).toHaveAttribute("data-repeated", "0");

  const before = await readCalendar(page);
  const blockRow = before.blocks.find((row) => row.title.includes("Hike")) ?? before.blocks[0];
  if (!blockRow) throw new Error("block missing");

  const handle = block(page, blockRow.title);
  const at = await center(handle);
  const rowBox = await folded.boundingBox();
  if (!rowBox) throw new Error("folded row missing");
  await touchDrag(page, testInfo.project.name, at.x, at.y, at.x, rowBox.y + rowBox.height / 2, 420);
  await touchDrag(page, testInfo.project.name, at.x, rowBox.y + 20, at.x, rowBox.y + 20, 0);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("tray-save-message"),
    includes: ["→ Sun 1:30 AM"],
    blocks: [{ id: blockRow.id, starts_at: "2026-11-01T05:30:00.000Z" }],
  });
});
