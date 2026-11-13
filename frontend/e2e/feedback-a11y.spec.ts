import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("menu Send feedback focuses note field", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("more-button").click();
  await page.getByTestId("send-feedback-row").click();
  const field = page.getByTestId("feedback-note");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("aria-label", "What happened?");
});
