import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("context line includes view and build", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  const line = page.getByTestId("feedback-context");
  await expect(line).toContainText("Day ·");
  await expect(line).toContainText("build");
});

test("screenshot remove and restore", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  const remove = page.getByTestId("feedback-remove-shot");
  if (await remove.isVisible()) {
    await remove.click();
    await page.getByTestId("feedback-add-shot").click();
  }
});
