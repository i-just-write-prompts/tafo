import { expect, test } from "@playwright/test";
import { reseed } from "./support";
import { twoFingerHold } from "./helpers/feedbackTouch";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("second finger during drag does nothing", async ({ page }) => {
  await page.goto("/");
  const block = page.locator(".block").first();
  await block.dispatchEvent("pointerdown");
  await page.waitForTimeout(350);
  await twoFingerHold(page, 200, 500, 300);
  await expect(page.getByTestId("feedback-sheet")).not.toBeVisible();
});

