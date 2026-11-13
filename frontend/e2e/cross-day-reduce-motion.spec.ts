import { expect, test } from "@playwright/test";

import { block, center, openDay, reseed, skipUnlessTouch, touchDrag } from "./support";

/**
 * v4 testids:
 * - day-pager data-transition="cross-fade"
 * - strip-dwell-ring (fill still progresses under reduced motion)
 */

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("prefers-reduced-motion: cross-fade, no slide", async ({ page }, testInfo) => {
  test.skip(skipUnlessTouch(testInfo.project.name), "touch cross-day");

  const pager = page.getByTestId("day-pager");
  await expect(pager).toHaveAttribute("data-transition", "cross-fade");

  const start = await center(block(page, "Call vendor,"));
  const strip = page.getByTestId("day-strip");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("strip");
  await touchDrag(page, testInfo.project.name, start.x, start.y, stripBox.x + 120, stripBox.y + 12, 420);

  const thu = page.getByTestId("strip-cell-thu");
  const thuBox = await thu.boundingBox();
  if (!thuBox) throw new Error("thu");
  const samples: number[] = [];
  await page.evaluate(() => {
    const pager = document.querySelector("[data-testid='day-pager']");
    if (!(pager instanceof HTMLElement)) return;
    (window as unknown as { __slideX: number[] }).__slideX = [];
    const obs = new MutationObserver(() => {
      const x = pager.getAttribute("data-translate-x");
      if (x) (window as unknown as { __slideX: number[] }).__slideX.push(Number(x));
    });
    obs.observe(pager, { attributes: true, attributeFilter: ["data-translate-x"] });
  });
  const t0 = Date.now();
  await touchDrag(page, testInfo.project.name, thuBox.x + 12, thuBox.y + 10, thuBox.x + 12, thuBox.y + 10, 500);
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThanOrEqual(150 + 400);
  samples.push(...(await page.evaluate(() => (window as unknown as { __slideX?: number[] }).__slideX ?? [])));
  expect(samples.every((x) => Math.abs(x) < 2)).toBe(true);
  await expect(thu.getByTestId("strip-dwell-ring")).toHaveAttribute("data-progress", "1");
});
