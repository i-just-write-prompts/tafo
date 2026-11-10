import { expect, test } from "@playwright/test";

import { block, center, dragHold, openDay, press, reseed, shot } from "./support";

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("opens on Day", async ({ page }, testInfo) => {
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByTestId("view-switch")).toContainText("Day");
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByRole("button", { name: /Call vendor/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await shot(page, testInfo, "opens-on-day");
});

test("quick drag saves with a toast and Undo", async ({ page }, testInfo) => {
  const vendor = block(page, "Call vendor,");
  const start = await center(vendor);
  const scrollBefore = await page.getByTestId("day-grid").evaluate((node) => node.scrollTop);
  await dragHold(page, start.x, start.y, start.x, start.y + 60);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toContainText("Call vendor → 11:00 AM");
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  const toastBox = await toast.boundingBox();
  const trayBox = await page.locator(".v3-tray").boundingBox();
  const budgetBox = await block(page, "Budget sheet").boundingBox();
  const gridBox = await page.getByTestId("day-grid").boundingBox();
  const scrollAfter = await page.getByTestId("day-grid").evaluate((node) => node.scrollTop);
  if (!toastBox || !trayBox || !budgetBox || !gridBox) throw new Error("toast geometry missing");
  expect(scrollAfter).toBe(scrollBefore);
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(trayBox.y + 1);
  const budgetBottom = Math.min(budgetBox.y + budgetBox.height, gridBox.y + gridBox.height);
  const coversBudget = toastBox.y < budgetBottom - 1 && toastBox.y + toastBox.height > budgetBox.y + 1;
  expect(coversBudget).toBe(false);
  await shot(page, testInfo, "quick-drag-toast");
  await press(toast.getByRole("button", { name: "Undo" }), testInfo.project.name);
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
});

test("tap event reveals approve and deny", async ({ page }, testInfo) => {
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Budget sheet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.getByText("Why: due Fri; longest free work stretch today.")).toBeVisible();
  await shot(page, testInfo, "event-tapped");
});

test("deny", async ({ page }, testInfo) => {
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await press(page.getByRole("button", { name: "Deny", exact: true }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toHaveText("Denied · Budget sheet → Unscheduled");
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
  await shot(page, testInfo, "denied");
});

async function touchDrag(page: import("@playwright/test").Page, fromX: number, fromY: number, toX: number, toY: number) {
  const client = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 0.5, rotationAngle: 0 });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(fromX, fromY)] });
  await page.waitForTimeout(450);
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(fromX + ((toX - fromX) * step) / steps, fromY + ((toY - fromY) * step) / steps)],
    });
    await page.waitForTimeout(16);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(200);
}

test("Week view", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Nov 9–15" })).toBeVisible();
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId("view-switch")).toContainText("Week");
  await expect(page.getByRole("button", { name: /Spec review/ })).toBeVisible();
  await shot(page, testInfo, "week");
});

test("narrow week drags retimes morning blocks and a partly hidden one", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const grid = page.getByTestId("week-grid");
  const scrollAtOpen = await grid.evaluate((node) => node.scrollTop);
  expect(scrollAtOpen).toBe(0);

  async function dragBy(name: string, fromX: number, fromY: number, toX: number, toY: number) {
    if (testInfo.project.name === "s23") await touchDrag(page, fromX, fromY, toX, toY);
    else await dragHold(page, fromX, fromY, toX, toY);
  }

  const spec = block(page, "Spec review");
  const specBefore = await spec.getAttribute("aria-label");
  const specAt = await center(spec);
  await dragBy("Spec review", specAt.x, specAt.y, specAt.x, specAt.y + 80);
  await expect(spec).not.toHaveAttribute("aria-label", specBefore ?? "");

  const notes = block(page, "Draft Q4 notes");
  const notesBefore = await notes.getAttribute("aria-label");
  const notesAt = await center(notes);
  await dragBy("Draft Q4 notes", notesAt.x, notesAt.y, notesAt.x, notesAt.y + 80);
  await expect(notes).not.toHaveAttribute("aria-label", notesBefore ?? "");

  const hike = block(page, /^Hike,/);
  const hikeBefore = await hike.getAttribute("aria-label");
  const clippedIt = await grid.evaluate((node) => {
    const target = node.querySelector("[aria-label^='Hike,']");
    if (!(target instanceof HTMLElement)) return false;
    const delta = target.getBoundingClientRect().top - node.getBoundingClientRect().top + 28;
    const max = node.scrollHeight - node.clientHeight;
    if (delta <= 0 || delta > max) return false;
    node.scrollTop += delta;
    return node.scrollTop > 0;
  });
  if (clippedIt) {
    const clipped = await hike.boundingBox();
    const gridNow = await grid.boundingBox();
    if (!clipped || !gridNow) throw new Error("hike left the grid");
    expect(clipped.y).toBeLessThan(gridNow.y + 4);
    const x = clipped.x + clipped.width / 2;
    const y = Math.min(gridNow.y + gridNow.height - 24, Math.max(gridNow.y + 16, clipped.y + 20));
    await dragBy("Hike", x, y, x, y + 60);
    await expect(hike).not.toHaveAttribute("aria-label", hikeBefore ?? "");
  }
});

test("Plan enter keeps the current view", async ({ page }, testInfo) => {
  await press(page.getByTestId("plan-button"), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toContainText("Drag blocks");
  await expect(page.getByTestId("plan-banner")).toContainText("nothing saves until Review");
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByTestId("day-grid")).toBeVisible();
  await expect(page.getByTestId("week-grid")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Tue/ })).toHaveAttribute("aria-checked", "true");
  await shot(page, testInfo, "plan-keeps-day");
});

test("rearrange several items then Approve all", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "week");

  const grid = page.getByTestId("week-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("week grid missing");
  const gutter = Number(await grid.getAttribute("data-gutter"));
  const column = (gridBox.width - gutter - 2) / 7;

  const spec = await center(block(page, "Spec review"));
  await dragHold(page, spec.x, spec.y, gridBox.x + gutter + column * 2 + column / 2, spec.y);
  const lunch = await center(block(page, "Lunch w/ Sam"));
  await dragHold(page, lunch.x, lunch.y, gridBox.x + gutter + column * 3 + column / 2, lunch.y);
  const gymBlock = block(page, "Gym");
  await gymBlock.scrollIntoViewIfNeeded();
  const gym = await center(gymBlock);
  const limit = (page.viewportSize()?.height ?? 800) - 24;
  await dragHold(page, gym.x, gym.y, gym.x, Math.min(gym.y + 80, limit));

  await expect(page.getByTestId("plan-banner")).toContainText("3 moves");
  await expect(page.getByTestId("plan-banner")).toContainText("agent suggests 2");
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const approve = page.getByRole("button", { name: "Approve all · 3 moves + 2 proposals" });
  await expect(approve).toBeVisible();
  await shot(page, testInfo, "review");
  await press(approve, testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toContainText("Approved 3 moves + 2 proposals");
  await expect(page.getByRole("button", { name: /Budget sheet,.*Proposed/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fix closet door,.*Proposed/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Spec review, Wed/ })).toBeVisible();
});

test("Revert restores staged moves and leaves proposals pending", async ({ page }, testInfo) => {
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const vendor = await center(block(page, "Call vendor,"));
  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  const lunch = await center(block(page, "Lunch w/ Sam"));
  await dragHold(page, lunch.x, lunch.y, lunch.x, lunch.y + 60);
  await expect(page.getByTestId("plan-banner")).toContainText("2 moves");
  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await shot(page, testInfo, "revert-sheet");
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await expect(page.getByTestId("plan-toast")).toHaveText("Reverted. Nothing changed.");
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  await expect(page.getByTestId("plan-toast")).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Budget sheet,.*Proposed/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();
});

test("30-minute block tap split", async ({ page }, testInfo) => {
  const grid = page.getByTestId("day-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("day grid missing");
  const origin = Number(await grid.getAttribute("data-origin"));
  const px = Number(await grid.getAttribute("data-hour-px"));
  const x = box.x + 90;
  const y929 = box.y + (9 + 29 / 60 - origin) * px;
  const y931 = box.y + (9 + 31 / 60 - origin) * px;
  await page.mouse.click(x, y929);
  await expect(page.getByRole("heading", { name: "Standup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await shot(page, testInfo, "standup-hit");
  await page.keyboard.press("Escape");
  await page.mouse.click(x, y931);
  await expect(page.getByRole("heading", { name: "Spec review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
});

test("keyboard-only path", async ({ page }) => {
  async function focusedName(): Promise<string> {
    return page.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement) || node === document.body) return "";
      return node.getAttribute("aria-label") || node.innerText || "";
    });
  }
  async function focusMatching(pattern: RegExp) {
    for (let step = 0; step < 40; step += 1) {
      if (pattern.test(await focusedName())) return;
      await page.keyboard.press("Tab");
    }
    throw new Error(`keyboard focus did not reach ${pattern}`);
  }

  await focusMatching(/Call vendor/);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("plan-toast")).toContainText("Call vendor → 10:15 AM");
  await focusMatching(/^Undo$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();

  await focusMatching(/Budget sheet/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await focusMatching(/^Deny$/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plan-toast")).toHaveText("Denied · Budget sheet → Unscheduled");
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
});

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("opening Review does not scroll the page or overshoot the sheet", async ({ page }, testInfo) => {
    await press(page.getByTestId("plan-button"), testInfo.project.name);
    const vendor = await center(block(page, "Call vendor,"));
    await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
    await page.evaluate(() => {
      const samples: Array<{ shell: number; grid: number; banner: number; top: number | null }> = [];
      (window as unknown as { __sheet: typeof samples }).__sheet = samples;
      const tick = () => {
        const shell = document.querySelector(".v3");
        const grid = document.querySelector(".v3-grid");
        const banner = document.querySelector(".v3-banner");
        const sheet = document.querySelector(".sheet");
        if (shell instanceof HTMLElement && grid instanceof HTMLElement && banner instanceof HTMLElement) {
          samples.push({
            shell: shell.scrollTop,
            grid: grid.scrollTop,
            banner: banner.getBoundingClientRect().top,
            top: sheet instanceof HTMLElement ? sheet.getBoundingClientRect().top : null,
          });
        }
        if (samples.length < 24) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const before = await page.evaluate(() => {
      const banner = document.querySelector(".v3-banner");
      return banner instanceof HTMLElement ? banner.getBoundingClientRect().top : 0;
    });
    await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
    await page.waitForTimeout(450);
    const samples = await page.evaluate(() => (window as unknown as { __sheet: Array<{ shell: number; grid: number; banner: number; top: number | null }> }).__sheet);
    const gridBefore = samples.find((sample) => sample.top == null)?.grid ?? samples[0]?.grid ?? 0;
    expect(samples.length).toBeGreaterThan(8);
    for (const sample of samples) {
      expect(sample.shell).toBe(0);
      expect(sample.grid).toBe(gridBefore);
      expect(Math.abs(sample.banner - before)).toBeLessThan(2);
    }
    const tops = samples.map((sample) => sample.top).filter((top): top is number => top != null);
    expect(tops.length).toBeGreaterThan(4);
    const resting = tops[tops.length - 1];
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(resting - 2);
    expect(tops[0]).toBeGreaterThan(resting + 24);
  });

  test("a dropped block settles from the held spot", async ({ page }) => {
    const vendor = block(page, "Call vendor,");
    const start = await center(vendor);
    const testId = await vendor.getAttribute("data-testid");
    if (!testId) throw new Error("block missing test id");
    await page.evaluate((id) => {
      const read = (selector: string) => {
        const face = document.querySelector(selector);
        const grid = document.querySelector(".v3-grid");
        if (!(face instanceof HTMLElement) || !(grid instanceof HTMLElement)) return null;
        const rect = face.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        return { x: rect.x - gridRect.x, y: rect.y - gridRect.y + grid.scrollTop, w: rect.width, h: rect.height };
      };
      (window as unknown as { __drops: Array<{ x: number; y: number; w: number; h: number }> }).__drops = [];
      (window as unknown as { __read: typeof read }).__read = read;
      window.addEventListener("pointerup", () => {
        const tick = () => {
          const box = read(`[data-testid="${id}"] .face`);
          const dropped = (window as unknown as { __drops: Array<{ x: number; y: number; w: number; h: number }> }).__drops;
          if (box) dropped.push(box);
          if (dropped.length < 18) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, { once: true });
    }, testId);
    const origin = await page.evaluate((id) => (window as unknown as { __read: (selector: string) => { x: number; y: number; w: number; h: number } | null }).__read(`[data-testid="${id}"] .face`), testId);
    if (!origin) throw new Error("block missing before the drag");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.waitForTimeout(420);
    await page.mouse.move(start.x, start.y + 70, { steps: 12 });
    const held = await page.evaluate((id) => (window as unknown as { __read: (selector: string) => { x: number; y: number; w: number; h: number } | null }).__read(`[data-testid="${id}"] .face`), testId);
    if (!held) throw new Error("block did not lift");
    await page.mouse.up();
    await page.waitForTimeout(500);
    const samples = await page.evaluate(() => (window as unknown as { __drops: Array<{ x: number; y: number; w: number; h: number }> }).__drops);
    expect(samples.length).toBeGreaterThan(6);
    expect(Math.abs(samples[0].y - held.y)).toBeLessThan(10);
    expect(Math.abs(samples[0].x - held.x)).toBeLessThan(10);
    expect(Math.abs(samples[0].w - held.w)).toBeLessThan(12);
    const final = samples[samples.length - 1];
    expect(final.w, "held block should grow into its lane").toBeGreaterThan(held.w + 12);
    expect(Math.abs(held.y - origin.y), "drag should leave the start row").toBeGreaterThan(30);
    for (const sample of samples) {
      expect(Math.abs(sample.y - origin.y), "dropped block jumped back to its start").toBeGreaterThan(20);
      const dx = final.x - held.x;
      const dy = final.y - held.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((sample.x - held.x) * dx + (sample.y - held.y) * dy) / len2));
      const distance = Math.hypot(sample.x - (held.x + t * dx), sample.y - (held.y + t * dy));
      expect(distance).toBeLessThan(16);
      expect(sample.w).toBeGreaterThan(Math.min(held.w, final.w) - 8);
      expect(sample.w).toBeLessThan(Math.max(held.w, final.w) + 8);
    }
  });
});
