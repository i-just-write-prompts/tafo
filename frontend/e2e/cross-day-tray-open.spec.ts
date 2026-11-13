import { expect, test } from "@playwright/test";

import { block, center, openDay, press, reseed, skipUnlessTouch, touchDrag } from "./support";

/**
 * v4 testids:
 * - tray-save-message (message text is tappable, separate from Undo)
 * - cross-day-highlight (soft highlight on opened block)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("after the return, tap the message text (not Undo)", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, testInfo.project.name, start.x, start.y, stripBox.x + 150, stripBox.y + 12, 420);
  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu");
  await touchDrag(page, testInfo.project.name, thuBox.x + 12, thuBox.y + 10, thuBox.x + 12, thuBox.y + 10, 500);
  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  await touchDrag(page, testInfo.project.name, gridBox.x + 80, gridBox.y + 360, gridBox.x + 80, gridBox.y + 360, 0);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible({ timeout: 5_000 });

  const message = page.getByTestId("tray-save-message");
  await expect(message).toContainText("Call vendor → Thu 2 PM");
  const undo = message.getByRole("button", { name: "Undo" });
  const undoBox = await undo.boundingBox();
  const messageText = message.getByTestId("tray-save-message-text");
  const textBox = await messageText.boundingBox();
  if (!undoBox || !textBox) throw new Error("message geometry");
  expect(undoBox.x).toBeGreaterThan(textBox.x + textBox.width - 4);

  await press(messageText, testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  const moved = block(page, "Call vendor");
  await moved.scrollIntoViewIfNeeded();
  await expect(moved).toHaveAttribute("data-highlight", "cross-day");
  await expect(undo).toBeVisible();
  await press(undo, testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
});
