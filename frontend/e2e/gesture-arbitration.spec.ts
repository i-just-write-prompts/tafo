import { expect, test } from "@playwright/test";

import { block, center, openDay, openWeek, press, reseed, skipUnlessTouch, touchDrag, touchSwipe } from "./support";

/**
 * v4 testids:
 * - day-pager / week-pager: data-pan-kind (scroll | swipe | hold-drag | edge-excluded)
 * - day-grid: data-momentum="0|1"
 * - jump-sheet, tray-sheet, day-strip: data-blocks-day-pager="1"
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("hold lifts, swipe pages, vertical scrolls, momentum stops", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch arbitration");

  const grid = page.getByTestId("day-grid");
  const pager = page.getByTestId("day-pager");
  await expect(pager).toHaveAttribute("data-enabled", "1");

  const mid = await grid.evaluate((node) => {
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.45);
    return node.scrollTop;
  });
  expect(mid).toBeGreaterThan(20);

  const lunch = block(page, "Lunch w/ Sam");
  const at = await center(lunch);
  const beforeLabel = await lunch.getAttribute("aria-label");
  const box = await grid.boundingBox();
  if (!box) throw new Error("day grid missing");

  await touchSwipe(page, testInfo.project.name, at.x, at.y, at.x - Math.round(box.width * 0.42), at.y, 0);
  await expect(page.getByTestId("day-pager")).toHaveAttribute("data-pan-kind", "swipe");
  await expect(lunch).toHaveAttribute("aria-label", beforeLabel ?? "");
  await expect(page.getByRole("heading", { name: /Mon, Nov 9|Wed, Nov 11/ })).toBeVisible();

  await touchDrag(page, testInfo.project.name, at.x, at.y, at.x, at.y + 70, 420);
  await expect(page.getByTestId("day-pager")).toHaveAttribute("data-pan-kind", "hold-drag");

  await grid.evaluate((node) => {
    node.scrollTop = mid;
  });
  await touchSwipe(page, testInfo.project.name, box.x + 40, box.y + 200, box.x + 44, box.y + 320, 0);
  expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(mid + 30);
  await expect(grid).toHaveAttribute("data-momentum", "1");

  const moving = await grid.evaluate((node) => node.scrollTop);
  await touchDrag(page, testInfo.project.name, box.x + 80, box.y + 220, box.x + 80, box.y + 220, 0);
  await page.waitForTimeout(120);
  const stopped = await grid.evaluate((node) => node.scrollTop);
  expect(Math.abs(stopped - moving)).toBeLessThan(4);
  await expect(lunch).toHaveAttribute("aria-label", beforeLabel ?? "");
});

test("edge touches never page; sheet, tray and strip block the day pager", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch arbitration");

  const title = await page.getByRole("heading", { name: "Tue, Nov 10" }).innerText();
  const grid = page.getByTestId("day-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("grid missing");
  const y = box.y + 200;

  await touchSwipe(page, testInfo.project.name, 8, y, 80, y, 0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.getByTestId("day-pager")).toHaveAttribute("data-pan-kind", "edge-excluded");

  await press(page.getByTestId("day-title-jump"), testInfo.project.name);
  await expect(page.getByTestId("month-grid-sheet")).toBeVisible();
  await touchSwipe(page, testInfo.project.name, box.x + 40, box.y + 300, box.x - 120, box.y + 300, 0);
  await expect(page.getByTestId("month-grid-sheet")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

  await page.keyboard.press("Escape");
  await press(page.getByTestId("sync-chip"), testInfo.project.name);
  const tray = page.getByTestId("tray-sheet");
  await expect(tray).toHaveAttribute("data-open", "1");
  const trayBox = await tray.boundingBox();
  if (!trayBox) throw new Error("tray missing");
  await touchSwipe(page, testInfo.project.name, trayBox.x + 40, trayBox.y + 80, trayBox.x - 120, trayBox.y + 80, 0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip missing");
  await touchSwipe(page, testInfo.project.name, stripBox.x + 30, stripBox.y + 10, stripBox.x - 100, stripBox.y + 10, 0);
  await expect(page.getByTestId("week-strip")).toHaveAttribute("data-week-offset", /[+-]1/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});

test("diagonal steeper than 30° scrolls instead of paging", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch arbitration");

  const grid = page.getByTestId("day-grid");
  const top = await grid.evaluate((node) => {
    node.scrollTop = 60;
    return node.scrollTop;
  });
  const box = await grid.boundingBox();
  if (!box) throw new Error("grid missing");
  const x = box.x + box.width / 2;
  await touchSwipe(page, testInfo.project.name, x, box.y + 120, x - 60, box.y + 260, 0);
  expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(top + 20);
  await expect(page.getByTestId("day-pager")).toHaveAttribute("data-pan-kind", "scroll");
});
