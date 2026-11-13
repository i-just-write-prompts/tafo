import type { Page } from "@playwright/test";

export async function twoFingerHold(page: Page, x: number, y: number, holdMs = 650) {
  const root = page.locator(".v3");
  await root.dispatchEvent("pointerdown", { pointerId: 11, clientX: x, clientY: y, pointerType: "touch", buttons: 1 });
  await page.waitForTimeout(40);
  await root.dispatchEvent("pointerdown", { pointerId: 12, clientX: x + 1, clientY: y + 1, pointerType: "touch", buttons: 1 });
  await page.waitForTimeout(holdMs);
  await root.dispatchEvent("pointerup", { pointerId: 11, clientX: x, clientY: y, pointerType: "touch" });
  await root.dispatchEvent("pointerup", { pointerId: 12, clientX: x + 1, clientY: y + 1, pointerType: "touch" });
}
