/* Statechart repros. Each test asserts the rule from the statechart pass.
   A failing test is the bug path replayed against the app. */
import { expect, test, type Page } from "@playwright/test";

import { armWriteFailure, checkSaveClaim, readCalendar } from "./helpers/saveClaim";
import { block, center, dragHold, openDay, press, reseed } from "./support";

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

test("PM2 a saved quick drag keeps Undo and its new spot when the re-read fails", async ({ page }, testInfo) => {
  const before = await blockRow(page, "Lunch w/ Sam");
  if (!before) throw new Error("fixture missing");
  let failReads = false;
  await page.route("**/api/decisions/*/approve", async (route) => {
    const response = await route.fetch();
    failReads = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/calendar/blocks", (route) => (failReads ? route.abort() : route.continue()));
  await drag(page, "Lunch w/ Sam", 60);
  await page.waitForTimeout(1500);
  const after = await blockRow(page, "Lunch w/ Sam");
  const undoCount = await page.getByRole("button", { name: "Undo" }).count();
  const label = await block(page, "Lunch w/ Sam").getAttribute("aria-label");
  await page.waitForTimeout(3500);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await drag(page, "Lunch w/ Sam", 120);
  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  expect(after?.starts_at, "the save reached the server").not.toBe(before.starts_at);
  expect(undoCount, "Undo is offered after a quick save").toBeGreaterThan(0);
  expect(label ?? "", "the block shows where Mike put it (1 PM)").toMatch(/1:00–2:00/);
});

test("PM1 a second quick drag while the first one saves is not thrown away", async ({ page }) => {
  const lunchBefore = await blockRow(page, "Lunch w/ Sam");
  const vendorBefore = await blockRow(page, "Call vendor");
  if (!lunchBefore || !vendorBefore) throw new Error("fixture missing");
  await page.route("**/api/decisions/*/approve", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await drag(page, "Lunch w/ Sam", 60);
  await drag(page, "Call vendor", 120);
  await page.waitForTimeout(8000);
  const lunch = await blockRow(page, "Lunch w/ Sam");
  const vendor = await blockRow(page, "Call vendor");
  expect(lunch?.starts_at).not.toBe(lunchBefore.starts_at);
  expect(vendor?.starts_at, "second drag was saved").not.toBe(vendorBefore.starts_at);
});

test("PR1 moving a Proposed block outside Plan mode makes it Mike's decision", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budgetProposal = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  if (!budgetProposal) throw new Error("fixture missing");
  const budget = block(page, "Budget sheet");
  await expect(budget).toHaveAttribute("aria-label", /Proposed/);
  await drag(page, "Budget sheet", 60);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toBeVisible();
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Budget sheet → 3:00 PM"],
    proposals: [{ id: budgetProposal.id, status: "approved" }],
    blocks: [{ taskTitle: "Budget sheet", starts_at: "2026-11-10T20:00:00Z", ends_at: "2026-11-10T21:30:00Z" }],
  });
  const label = await block(page, "Budget sheet").getAttribute("aria-label");
  await press(block(page, "Budget sheet"), testInfo.project.name);
  const approveButtons = await page.getByRole("button", { name: "Approve", exact: true }).count();
  const denyButtons = await page.getByRole("button", { name: "Deny", exact: true }).count();
  expect(label ?? "", "no Proposed after Mike moves it").not.toMatch(/Proposed/);
  expect(approveButtons + denyButtons, "no Approve/Deny after Mike moves it").toBe(0);
});

test("PR2 Approve all takes every listed suggestion even when its calendar is hidden", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const closet = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Fix closet door"));
  const budget = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  if (!closet || !budget) throw new Error("fixture missing");
  await press(page.getByTestId("more-button"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: /Show/ }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Home" }), testInfo.project.name);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await dragHold(page, at.x, at.y, at.x + column, at.y);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const sheet = page.getByTestId("review-sheet");
  const listed = await sheet.innerText();
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: ["Approved"],
    proposals: [
      { id: closet.id, status: "approved" },
      { id: budget.id, status: "approved" },
    ],
  });
  expect(listed).toContain("Fix closet door");
});
