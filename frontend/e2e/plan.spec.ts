import { expect, test } from "@playwright/test";

import { block, center, dragHold, openDay, press, reseed, shot } from "./support";

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("opens on Day", async ({ page }, testInfo) => {
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByTestId("view-switch")).toContainText("Day");
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByRole("button", { name: /Call vendor/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await shot(page, testInfo, "opens-on-day");
});

test("quick drag saves with a toast and Undo", async ({ page }, testInfo) => {
  const vendor = block(page, "Call vendor,");
  const start = await center(vendor);
  await dragHold(page, start.x, start.y, start.x, start.y + 60);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toContainText("Call vendor → 11:00 AM");
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  await shot(page, testInfo, "quick-drag-toast");
  await press(toast.getByRole("button", { name: "Undo" }), testInfo.project.name);
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
});

test("tap event reveals approve and deny", async ({ page }, testInfo) => {
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Budget sheet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.getByText("Why: due Fri; longest free work stretch today.")).toBeVisible();
  await shot(page, testInfo, "event-tapped");
});

test("deny", async ({ page }, testInfo) => {
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await press(page.getByRole("button", { name: "Deny", exact: true }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toHaveText("Denied. Alternates aren't built yet.");
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
  await shot(page, testInfo, "denied");
});

test("Week view", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Nov 9–15" })).toBeVisible();
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId("view-switch")).toContainText("Week");
  await expect(page.getByRole("button", { name: /Spec review/ })).toBeVisible();
  await shot(page, testInfo, "week");
});

test("Plan enter keeps the current view", async ({ page }, testInfo) => {
  await press(page.getByTestId("plan-button"), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toContainText("Drag blocks");
  await expect(page.getByTestId("plan-banner")).toContainText("nothing saves until Review");
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByTestId("day-grid")).toBeVisible();
  await expect(page.getByTestId("week-grid")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Tue/ })).toHaveAttribute("aria-checked", "true");
  await shot(page, testInfo, "plan-keeps-day");
});

test("rearrange several items then Approve all", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "week");

  const grid = page.getByTestId("week-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("week grid missing");
  const gutter = Number(await grid.getAttribute("data-gutter"));
  const column = (gridBox.width - gutter - 2) / 7;

  const spec = await center(block(page, "Spec review"));
  await dragHold(page, spec.x, spec.y, gridBox.x + gutter + column * 2 + column / 2, spec.y);
  const lunch = await center(block(page, "Lunch w/ Sam"));
  await dragHold(page, lunch.x, lunch.y, gridBox.x + gutter + column * 3 + column / 2, lunch.y);
  const gymBlock = block(page, "Gym");
  await gymBlock.scrollIntoViewIfNeeded();
  const gym = await center(gymBlock);
  const limit = (page.viewportSize()?.height ?? 800) - 24;
  await dragHold(page, gym.x, gym.y, gym.x, Math.min(gym.y + 80, limit));

  await expect(page.getByTestId("plan-banner")).toContainText("3 moves");
  await expect(page.getByTestId("plan-banner")).toContainText("agent suggests 2");
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const approve = page.getByRole("button", { name: "Approve all · 3 moves + 2 proposals" });
  await expect(approve).toBeVisible();
  await shot(page, testInfo, "review");
  await press(approve, testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toContainText("Approved 3 moves + 2 proposals");
  await expect(page.getByRole("button", { name: /Budget sheet,.*Proposed/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fix closet door,.*Proposed/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Spec review, Wed/ })).toBeVisible();
});

test("Revert restores staged moves and leaves proposals pending", async ({ page }, testInfo) => {
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const vendor = await center(block(page, "Call vendor,"));
  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  const lunch = await center(block(page, "Lunch w/ Sam"));
  await dragHold(page, lunch.x, lunch.y, lunch.x, lunch.y + 60);
  await expect(page.getByTestId("plan-banner")).toContainText("2 moves");
  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await shot(page, testInfo, "revert-sheet");
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toHaveText("Reverted. Nothing changed.");
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Budget sheet,.*Proposed/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
});

test("30-minute block tap split", async ({ page }, testInfo) => {
  const grid = page.getByTestId("day-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("day grid missing");
  const origin = Number(await grid.getAttribute("data-origin"));
  const px = Number(await grid.getAttribute("data-hour-px"));
  const x = box.x + 90;
  const y929 = box.y + (9 + 29 / 60 - origin) * px;
  const y931 = box.y + (9 + 31 / 60 - origin) * px;
  await page.mouse.click(x, y929);
  await expect(page.getByRole("heading", { name: "Standup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await shot(page, testInfo, "standup-hit");
  await page.keyboard.press("Escape");
  await page.mouse.click(x, y931);
  await expect(page.getByRole("heading", { name: "Spec review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
});

test("keyboard-only path", async ({ page }) => {
  async function focusedName(): Promise<string> {
    return page.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement) || node === document.body) return "";
      return node.getAttribute("aria-label") || node.innerText || "";
    });
  }
  async function focusMatching(pattern: RegExp) {
    for (let step = 0; step < 40; step += 1) {
      if (pattern.test(await focusedName())) return;
      await page.keyboard.press("Tab");
    }
    throw new Error(`keyboard focus did not reach ${pattern}`);
  }

  await focusMatching(/Call vendor/);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("plan-toast")).toContainText("Call vendor → 10:15 AM");
  await focusMatching(/^Undo$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();

  await focusMatching(/Budget sheet/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await focusMatching(/^Deny$/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plan-toast")).toHaveText("Denied. Alternates aren't built yet.");
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
});
