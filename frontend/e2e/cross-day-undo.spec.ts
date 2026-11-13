import { expect, test } from "@playwright/test";

import { block, center, openDay, press, reseed, skipUnlessTouch, touchDrag } from "./support";
import { readCalendar } from "./helpers/saveClaim";

/**
 * v4 testids:
 * - tray-save-message, details-sheet proposal actions (Approve/Deny)
 * - strip-proposal-{dow}
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("Undo after the return restores day, time and Proposed", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const state = await readCalendar(page);
  const budgetProposal = state.proposals.find(
    (item) =>
      item.kind === "calendar_block" &&
      state.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"),
  );
  if (!budgetProposal) throw new Error("budget proposal missing");

  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Day" }), testInfo.project.name);

  const heading = await page.getByRole("heading", { level: 1 }).innerText();
  const start = await center(block(page, "Budget sheet"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, testInfo.project.name, start.x, start.y, stripBox.x + 140, stripBox.y + 12, 420);
  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu");
  await touchDrag(page, testInfo.project.name, thuBox.x + 12, thuBox.y + 10, thuBox.x + 12, thuBox.y + 10, 500);
  const grid = page.getByTestId("day-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("grid");
  await touchDrag(page, testInfo.project.name, gridBox.x + 80, gridBox.y + 340, gridBox.x + 80, gridBox.y + 340, 0);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 5_000 });

  const message = page.getByTestId("tray-save-message");
  await expect(message).toContainText(/Budget sheet → Thu/i);
  await press(message.getByRole("button", { name: "Undo" }), testInfo.project.name);
  await expect(page.getByRole("heading", { name: heading })).toHaveText(heading);
  await expect(block(page, "Budget sheet")).toHaveAttribute("aria-label", /Proposed/);

  const after = await readCalendar(page);
  const proposal = after.proposals.find((item) => item.id === budgetProposal.id);
  expect(proposal?.status).toBe("pending");
  const proposal = (await readCalendar(page)).proposals.find((item) => item.id === budgetProposal.id);
  expect(proposal?.status).toBe("pending");
});
