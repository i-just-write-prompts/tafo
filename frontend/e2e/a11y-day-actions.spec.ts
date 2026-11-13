import { expect, test } from "@playwright/test";

import { openDay, press, reseed } from "./support";

/**
 * v4 testids:
 * - a11y-previous-day, a11y-next-day (header actions; VoiceOver stand-in)
 * - day-pager: data-a11y-paged="1"
 */

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("previous/next day actions", async ({ page }, testInfo) => {
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await expect(page.getByTestId("a11y-previous-day")).toHaveAttribute("aria-label", /Previous day/i);
  await expect(page.getByTestId("a11y-next-day")).toHaveAttribute("aria-label", /Next day/i);

  await press(page.getByTestId("a11y-next-day"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Wed, Nov 11" })).toBeVisible();
  await expect(page.getByTestId("day-pager")).toHaveAttribute("data-a11y-paged", "1");

  const grid = page.getByTestId("day-grid");
  const hour = await grid.getAttribute("data-scroll-hour");
  await press(page.getByTestId("a11y-previous-day"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await expect(grid).toHaveAttribute("data-scroll-hour", hour ?? "");
});
