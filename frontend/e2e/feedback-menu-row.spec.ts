import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("Send feedback is the last menu row with first-time subtitle", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("tafo.feedback.sentOnce"));
  await page.getByTestId("more-button").click();
  const row = page.getByTestId("send-feedback-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Or hold two fingers anywhere");
  await row.click();
  await expect(page.getByTestId("feedback-sheet")).toBeVisible();
});
