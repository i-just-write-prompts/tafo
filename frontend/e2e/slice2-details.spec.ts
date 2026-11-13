import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("details sheet has category chips", async ({ page }) => {
  await page.goto("/");
  const block = page.locator(".block").first();
  await block.click();
  await expect(page.getByTestId("event-sheet-slice2")).toBeVisible();
  await expect(page.getByTestId("category-work")).toBeVisible();
});

test("hours menu row opens sheet", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("hours-menu-row").click();
  await expect(page.getByTestId("hours-sheet")).toBeVisible();
});
