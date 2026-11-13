import { expect, test } from "@playwright/test";

test("slice2 flag on in e2e build", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".v3")).toHaveAttribute("data-slice2", "1");
  await page.getByTestId("more-button").click();
  await expect(page.getByTestId("send-feedback-row")).toBeVisible();
});
