import { expect, test } from "@playwright/test";

import { blockFace, columnDropPoint, dragBetween, FIXTURE_RANGE, openFixtureWeek, placeBlockInView, press, proposal, reseed, shot } from "./support";

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openFixtureWeek(page);
});

test("week view loads the demo fixture", async ({ page }, testInfo) => {
  await expect(page.getByRole("button", { name: "Week", pressed: true })).toBeVisible();
  await expect(page.getByText(FIXTURE_RANGE)).toBeVisible();
  await expect(page.getByText(/Demo\s+\u2013\s+not synced/)).toBeVisible();
  await expect(page.getByTestId("sidebar-task-task_journey_hike")).toContainText("Plan Saturday hike route");
  await expect(page.getByTestId("sidebar-task-task_journey_grandma")).toContainText("Call Grandma Rosa");
  await shot(page, testInfo, "week-loads");
  for (const title of ["Water the balcony herbs", "Fix the squeaky closet door", "Pick up dry cleaning"]) {
    const card = proposal(page, title);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
  }
  const ladder = page.getByRole("button", { name: /Hold the ladder, Wed Nov 4, 16:00\u201317:00/ });
  await ladder.scrollIntoViewIfNeeded();
  await expect(ladder).toBeVisible();
  await expect(ladder).toHaveAttribute("aria-label", /Wed Nov 4, 16:00\u201317:00/);
});

test("approve and deny an agent proposal", async ({ page }, testInfo) => {
  const herbs = proposal(page, "Water the balcony herbs");
  const door = proposal(page, "Fix the squeaky closet door");
  await herbs.scrollIntoViewIfNeeded();
  await door.scrollIntoViewIfNeeded();
  await expect(herbs).toBeVisible();
  await expect(door).toBeVisible();

  await press(herbs.getByRole("button", { name: "Approve", exact: true }), testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toHaveText("Approved.");
  await expect(proposal(page, "Water the balcony herbs")).toHaveCount(0);
  await expect(blockFace(page, "Water the balcony herbs")).toBeVisible();
  await expect(blockFace(page, "Water the balcony herbs")).not.toHaveAttribute("aria-label", /Proposed/);

  await press(door.getByRole("button", { name: "Deny", exact: true }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toHaveText("Denied. Alternates aren't built yet.");
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(proposal(page, "Fix the squeaky closet door")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fix the squeaky closet door/ })).toHaveCount(0);
  await shot(page, testInfo, "deny-toast");
});

test("approve day shows the pending count", async ({ page }, testInfo) => {
  const approveWednesday = page.getByRole("button", { name: "Approve day (2)", exact: true });
  const approveThursday = page.getByRole("button", { name: "Approve day (1)", exact: true });
  await expect(approveWednesday).toBeVisible();
  await expect(approveThursday).toBeVisible();
  await shot(page, testInfo, "approve-day-count");

  await press(approveWednesday, testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toHaveText("Approved 2.");
  await expect(page.getByRole("button", { name: "Approve day (2)", exact: true })).toHaveCount(0);
  await expect(proposal(page, "Water the balcony herbs")).toHaveCount(0);
  await expect(proposal(page, "Fix the squeaky closet door")).toHaveCount(0);
  await expect(blockFace(page, "Water the balcony herbs")).toBeVisible();
  await expect(blockFace(page, "Fix the squeaky closet door")).toBeVisible();
  await expect(approveThursday).toBeVisible();
  await expect(proposal(page, "Pick up dry cleaning")).toBeVisible();
});

test("drag a task onto the calendar shows an undo toast", async ({ page }, testInfo) => {
  const hike = page.getByTestId("sidebar-task-task_journey_hike");
  await expect(hike).toContainText("Plan Saturday hike route");
  const drop = await columnDropPoint(page, "2026-11-06");
  await hike.scrollIntoViewIfNeeded();
  const from = await hike.boundingBox();
  if (!from) throw new Error("hike row has no box");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(drop.x, drop.y, { steps: 24 });
    await expect(page.locator(".drag-ghost")).toHaveText("Plan Saturday hike route");
  } finally {
    await page.mouse.up();
  }

  const toast = page.getByTestId("undo-toast");
  await expect(toast).toContainText("Scheduled Plan Saturday hike route.");
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByTestId("sidebar-task-task_journey_hike")).toHaveCount(0);
  await expect(blockFace(page, "Plan Saturday hike route")).toBeVisible();
  await shot(page, testInfo, "undo-toast");
  await page.waitForTimeout(4_000);
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 8_000 });
});

test("moving a fixed block asks for confirmation", async ({ page }, testInfo) => {
  const ladder = blockFace(page, "Hold the ladder").and(page.getByRole("button", { name: /16:00\u201317:00/ }));
  await placeBlockInView(page, ladder);
  await expect(ladder).toBeVisible();
  const box = await ladder.boundingBox();
  const scroll = await page.locator(".cal-scroll").boundingBox();
  if (!box || !scroll) throw new Error("ladder has no box");
  const startX = box.x + Math.min(8, box.width / 3);
  const startY = box.y + Math.min(8, box.height / 3);
  const endY = Math.min(startY + 42, scroll.y + scroll.height - 12);
  if (endY - startY < 20) throw new Error("calendar viewport is too short to drag the fixed block");
  await dragBetween(page, startX, startY, startX, endY);

  const dialog = page.getByRole("dialog", { name: "Change this fixed block?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This appointment is fixed.");
  await shot(page, testInfo, "fixed-confirm");
  await press(page.getByTestId("fixed-cancel"), testInfo.project.name);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /Hold the ladder, Wed Nov 4, 16:00\u201317:00/ })).toBeVisible();
});
