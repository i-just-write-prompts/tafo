import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("Send disabled until text; discard empty cancel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  await expect(page.getByTestId("feedback-send")).toBeDisabled();
  await page.getByTestId("feedback-cancel").click();
  await expect(page.getByTestId("feedback-sheet")).not.toBeVisible();
});

test("typed note asks discard", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  await page.getByTestId("feedback-note").fill("Something odd");
  await page.getByTestId("feedback-cancel").click();
  await expect(page.getByTestId("feedback-discard")).toBeVisible();
});
