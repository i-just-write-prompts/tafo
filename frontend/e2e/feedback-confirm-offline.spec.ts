import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("tray Feedback sent · #42 for 4s without Undo", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  await page.getByTestId("feedback-note").fill("Tray check");
  await page.getByTestId("feedback-send").click();
  const msg = page.getByTestId("tray-message-line1");
  await expect(msg).toContainText("Feedback sent");
  await expect(msg).toContainText("#42");
  await expect(page.getByTestId("tray-undo")).toHaveCount(0);
});
