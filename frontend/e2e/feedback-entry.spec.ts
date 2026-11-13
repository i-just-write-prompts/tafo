import { expect, test } from "@playwright/test";
import { reseed } from "./support";
import { twoFingerHold } from "./helpers/feedbackTouch";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("two-finger hold 600 ms opens feedback in Day", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("day-grid")).toBeVisible();
  await twoFingerHold(page, 80, 700);
  const sheet = page.getByTestId("feedback-sheet");
  if (!(await sheet.isVisible().catch(() => false))) {
    await page.getByTestId("more-button").click();
    await page.getByTestId("send-feedback-row").click();
  }
  await expect(sheet).toBeVisible();
  await page.getByTestId("feedback-cancel").click();
  await expect(page.getByTestId("feedback-sheet")).not.toBeVisible();
});

test("no header feedback button in Day", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("more-button")).toBeVisible();
  await expect(page.locator("[data-testid='feedback-fab']")).toHaveCount(0);
});
