import { expect, test } from "@playwright/test";

import { block, center, dragHold, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";

/**
 * v4 testids:
 * - tray-save-message (AC 53 upper row; distinct from floating toast)
 * - tray-message-row, plan-toast (existing, upper row grows)
 * - day-grid: data-bottom-inset-pt (grows with message row)
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("save, then within 4 s tap or drag a block in the bottom 48pt", async ({ page }, testInfo) => {
  const grid = page.getByTestId("day-grid");
  const vendor = await center(block(page, "Call vendor,"));
  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  const insetBefore = Number(await grid.getAttribute("data-bottom-inset-pt")) || 0;

  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  const message = page.getByTestId("tray-save-message");
  await expect(message).toBeVisible();
  await expect(message).toContainText(/Call vendor →/i);
  await expect(grid).toHaveAttribute("data-bottom-inset-pt", "48");
  expect(await grid.evaluate((node) => node.scrollTop)).toBe(scrollBefore);

  const tray = page.locator(".v3-tray");
  const trayBox = await tray.boundingBox();
  const gridBox = await grid.boundingBox();
  if (!trayBox || !gridBox) throw new Error("geometry missing");
  const bottomBandY = Math.min(gridBox.y + gridBox.height - 24, trayBox.y - 8);
  const reachable = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit instanceof Element ? hit.closest(".block")?.getAttribute("data-testid") : null;
    },
    { x: vendor.x, y: bottomBandY },
  );
  expect(reachable).toMatch(/^block-/);

  test.skip(skipUnlessTouch(testInfo.project.name), "touch lift");
  await touchDrag(page, testInfo.project.name, vendor.x, bottomBandY, vendor.x, bottomBandY + 40, 420);
  await expect(message).toBeHidden({ timeout: 1_000 });
  await expect(grid).toHaveAttribute("data-bottom-inset-pt", String(insetBefore));
  await expect(page.getByTestId("autoscroll-zone-bottom")).toHaveAttribute("data-above-tray", "1");

  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  await expect(message).toBeVisible();
  const toastBox = await message.boundingBox();
  if (!toastBox) throw new Error("message missing");
  await touchDrag(page, testInfo.project.name, toastBox.x + 8, toastBox.y + 8, toastBox.x + 8, toastBox.y + 8, 0);
  await expect(page.getByRole("button", { name: /Call vendor/ })).toHaveAttribute("aria-label", /10:00/);
});
