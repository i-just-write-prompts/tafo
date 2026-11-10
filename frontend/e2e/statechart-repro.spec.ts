/* Statechart repros. Each test asserts the rule from the statechart pass.
   A failing test is the bug path replayed against the app. */
import { expect, test, type Page } from "@playwright/test";

import { armWriteFailure, checkSaveClaim, readCalendar } from "./helpers/saveClaim";
import { block, center, dragHold, openDay, reseed } from "./support";

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

async function drag(page: Page, title: string, dy: number, dx = 0) {
  const target = block(page, title);
  await target.scrollIntoViewIfNeeded();
  const at = await center(target);
  await dragHold(page, at.x, at.y, at.x + dx, at.y + dy);
}

async function blockRow(page: Page, title: string) {
  const state = await readCalendar(page);
  return state.blocks.find((item) => item.title === title && item.status === "scheduled");
}

test("SY1 a quick drag whose Google write fails never says saved and can be retried", async ({ page }) => {
  const before = await blockRow(page, "Lunch w/ Sam");
  if (!before) throw new Error("fixture missing");
  await armWriteFailure(page, [before.id]);
  await drag(page, "Lunch w/ Sam", 60);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toBeVisible();
  const text = await checkSaveClaim(page, {
    case: "forced-failure",
    toast,
    excludes: ["→"],
    blocks: [{ id: before.id, starts_at: before.starts_at, ends_at: before.ends_at }],
  });
  expect(text, "no success claim for a failed write").not.toMatch(/→/);
  expect(await page.getByRole("button", { name: /retry|try again/i }).count(), "a way to retry the failed edit").toBeGreaterThan(0);
});
