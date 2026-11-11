import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { armWriteFailure, checkSaveClaim, readCalendar, uiWhen } from "./helpers/saveClaim";
import { block, center, dragHold, openDay, press, reseed, shot } from "./support";

async function titleLayout(button: Locator) {
  await expect(button).toBeVisible();
  const blockBox = await button.boundingBox();
  if (!blockBox) throw new Error("block missing");
  const lines = button.locator("strong");
  const count = await lines.count();
  expect(count).toBeGreaterThan(0);
  const laid = [];
  for (let index = 0; index < count; index += 1) {
    const line = lines.nth(index);
    await expect(line).toBeVisible();
    const box = await line.boundingBox();
    if (!box) throw new Error("title line missing");
    const text = (await line.textContent()) || "";
    expect(box.height).toBeGreaterThanOrEqual(8);
    expect(box.width).toBeGreaterThan(0);
    expect(box.y).toBeGreaterThanOrEqual(blockBox.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(blockBox.y + blockBox.height + 1);
    if (index > 0) expect(box.y).toBeGreaterThanOrEqual(laid[index - 1].y + laid[index - 1].height - 1);
    laid.push({ ...box, text });
  }
  return { texts: laid.map((line) => line.text), lines: laid, block: blockBox };
}

async function expectOneLine(toast: Locator) {
  const line = await toast.locator("p").boundingBox();
  const pill = await toast.boundingBox();
  if (!line || !pill) throw new Error("toast geometry missing");
  expect(line.height).toBeLessThanOrEqual(22);
  expect(pill.height).toBeLessThanOrEqual(44);
}

function intersection(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

async function expectClearOfEvents(page: Page, toast: Locator) {
  const toastBox = await toast.boundingBox();
  const tray = await page.locator(".v3-tray").boundingBox();
  if (!toastBox || !tray) throw new Error("toast geometry missing");
  expect(toastBox.y).toBeGreaterThanOrEqual(tray.y - 1);
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(tray.y + tray.height + 1);
  await expect(page.getByTestId("unscheduled")).toContainText("Unscheduled");
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  const grip = await page.getByTestId("tray-grip").boundingBox();
  const gridBox = await page.locator(".v3-grid").boundingBox();
  if (grip && gridBox) {
    expect(grip.height).toBeGreaterThanOrEqual(44);
    expect(grip.y).toBeGreaterThanOrEqual(tray.y - 1);
    expect(grip.y + grip.height).toBeLessThanOrEqual(tray.y + tray.height + 1);
    expect(grip.y).toBeGreaterThanOrEqual(gridBox.y + gridBox.height - 1);
  }
  const hit = await toast.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return target instanceof Element ? target.closest("[data-testid='plan-toast'], [data-testid='tray-grip']")?.getAttribute("data-testid") : null;
  });
  expect(hit).toBe("plan-toast");
  for (const id of ["unscheduled", "sync-chip"]) {
    const control = await page.getByTestId(id).boundingBox();
    if (control && intersection(control, toastBox)) {
      expect(false, `toast overlaps ${id}`).toBe(true);
    }
  }
  const grid = page.locator(".v3-grid");
  const grids = [];
  for (const id of ["day-grid", "week-grid"]) {
    const item = page.getByTestId(id);
    if (await item.count() === 0) continue;
    const box = await item.boundingBox();
    if (box) grids.push(box);
  }
  const original = await grid.evaluate((node) => node.scrollTop);
  const stops = await grid.evaluate((node) => {
    const max = node.scrollHeight - node.clientHeight;
    return [0, Math.round(max / 2), max];
  });
  for (const top of stops) {
    await grid.evaluate((node, value) => { node.scrollTop = value; }, top);
    const blocks = await page.locator(".block, .slim").all();
    for (const item of blocks) {
      const box = await item.boundingBox();
      if (!box) continue;
      for (const gridBox of grids) {
        const visible = intersection(box, gridBox);
        if (visible && intersection(visible, toastBox)) {
          expect(false, `toast overlaps ${await item.getAttribute("aria-label")} at scroll ${top}`).toBe(true);
        }
      }
    }
  }
  await grid.evaluate((node, value) => { node.scrollTop = value; }, original);
}

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

test("opens on Day", async ({ page }, testInfo) => {
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByTestId("view-switch")).toContainText("Day");
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByRole("button", { name: /Call vendor/ })).toBeVisible();
  await expect(page.getByTestId("block-blk_v3_spec")).toHaveAttribute("data-title", "Spec review");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await shot(page, testInfo, "opens-on-day");
});

test("quick drag saves with a toast and Undo", async ({ page }, testInfo) => {
  const vendor = block(page, "Call vendor,");
  const start = await center(vendor);
  const grid = page.getByTestId("day-grid");
  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  const gridBefore = await grid.boundingBox();
  await dragHold(page, start.x, start.y, start.x, start.y + 60);
  const toast = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Call vendor → 11:00 AM"],
    blocks: [{ title: "Call vendor", starts_at: "2026-11-10T16:00:00Z", ends_at: "2026-11-10T16:30:00Z" }],
  });
  const undo = toast.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  const undoBox = await undo.boundingBox();
  expect(undoBox?.width).toBeGreaterThanOrEqual(44);
  expect(undoBox?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  await expectOneLine(toast);
  const gridBox = await grid.boundingBox();
  const scrollAfter = await grid.evaluate((node) => node.scrollTop);
  if (!gridBox || !gridBefore) throw new Error("grid geometry missing");
  expect(scrollAfter).toBe(scrollBefore);
  expect(gridBox.height).toBeCloseTo(gridBefore.height, 0);
  expect(gridBox.y).toBeCloseTo(gridBefore.y, 0);
  await expectClearOfEvents(page, toast);
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
  const before = await calendarState(page);
  const budget = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  if (!budget) throw new Error("budget missing");
  const toast = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Denied · Budget sheet → Unscheduled"],
    proposals: [{ id: budget.id, status: "rejected" }],
  });
  await expectOneLine(toast);
  await expectClearOfEvents(page, toast);
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
  await shot(page, testInfo, "denied");
});

/** Desktop and WebKit send a real pointer drag. Chromium touch sends a real touch drag. */
async function dragGrip(page: import("@playwright/test").Page, project: string, x: number, y: number, dy: number) {
  const sheet = page.locator(".tray-sheet");
  const sample = dy > 0 ? Math.min(40, dy / 2) : Math.max(-40, dy / 2);
  const read = async () => {
    const transform = await sheet.evaluate((el) => (el as HTMLElement).style.transform);
    const px = Number(/translateY\((-?[\d.]+)px\)/.exec(transform)?.[1]);
    expect(Number.isFinite(px), `sheet transform was ${transform}`).toBe(true);
    expect(Math.abs(px)).toBeGreaterThan(12);
  };
  if (project === "s23") {
    const client = await page.context().newCDPSession(page);
    const point = (px: number, py: number) => ({ x: px, y: py, id: 1, radiusX: 2, radiusY: 2, force: 0.5, rotationAngle: 0 });
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(x, y)] });
    await page.waitForTimeout(40);
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x, y + sample)] });
    await page.waitForTimeout(40);
    await read();
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x, y + dy)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + sample, { steps: 4 });
  await read();
  await page.mouse.move(x, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function uiDrag(page: import("@playwright/test").Page, project: string, fromX: number, fromY: number, toX: number, toY: number, hold = 450) {
  if (project === "s23") await touchDrag(page, fromX, fromY, toX, toY, hold);
  else await dragHold(page, fromX, fromY, toX, toY);
}

async function touchDrag(page: import("@playwright/test").Page, fromX: number, fromY: number, toX: number, toY: number, hold = 450) {
  const client = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 0.5, rotationAngle: 0 });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(fromX, fromY)] });
  await page.waitForTimeout(hold);
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

test("first touch drag after scrolling saves on the first try", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "s23", "360 touch");
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  const grid = page.getByTestId("week-grid");
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error("week grid missing");
  const scrollBefore = await grid.evaluate((node) => node.scrollTop);
  await touchDrag(page, gridBox.x + 14, gridBox.y + 240, gridBox.x + 14, gridBox.y + 140);
  expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollBefore + 40);

  async function dragOnce(title: string, scrollTop: number) {
    await grid.evaluate((node, top) => { node.scrollTop = top; }, scrollTop);
    const target = block(page, title);
    const before = await target.getAttribute("aria-label");
    const box = await target.boundingBox();
    const gridBox = await grid.boundingBox();
    if (!before || !box || !gridBox) throw new Error(`${title} missing`);
    const x = box.x + Math.min(18, box.width / 2);
    const y = Math.min(gridBox.y + gridBox.height - 28, Math.max(gridBox.y + 20, box.y + 18));
    await touchDrag(page, x, y, x, y + 90);
    const saved = await calendarState(page);
    const row = saved.blocks.find((item) => item.title.startsWith(title.replace(/,$/, "")) && item.status === "scheduled");
    if (!row) throw new Error(`${title} missing after drag`);
    await checkSaveClaim(page, {
      case: "matches-server",
      toast: page.getByTestId("plan-toast"),
      includes: ["→"],
      blocks: [{ id: row.id, starts_at: row.starts_at, ends_at: row.ends_at }],
    });
    await expect(target).not.toHaveAttribute("aria-label", before);
    return target.getAttribute("aria-label");
  }

  const specAfter = await dragOnce("Spec review", 80);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await expect(page.getByRole("button", { name: specAfter ?? "" })).toBeVisible();

  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  const hikeAfter = await dragOnce("Hike,", 51);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tue, Nov 10" })).toBeVisible();
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await expect(block(page, "Hike,")).toHaveAttribute("aria-label", hikeAfter ?? "");
});

test("a swipe on an event pans, and the next tap opens it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "touch scrolling");
  const grid = page.getByTestId("day-grid");
  const mid = await grid.evaluate((node) => {
    const max = node.scrollHeight - node.clientHeight;
    node.scrollTop = Math.round(max / 2);
    return { top: node.scrollTop, max };
  });
  expect(mid.top).toBeGreaterThan(8);
  expect(mid.max - mid.top).toBeGreaterThan(8);
  const lunch = block(page, "Lunch w/ Sam");
  const before = await lunch.getAttribute("aria-label");
  const box = await lunch.boundingBox();
  const gridBox = await grid.boundingBox();
  if (!box || !gridBox || !before) throw new Error("lunch missing");
  const x = box.x + Math.min(24, box.width / 2);
  const y = Math.min(gridBox.y + gridBox.height - 30, Math.max(gridBox.y + 24, box.y + 20));
  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    const button = node instanceof HTMLElement ? node.closest("button") : null;
    return button?.getAttribute("aria-label") ?? null;
  }, { x, y });
  expect(hit).toBe(before);
  if (testInfo.project.name === "s23") {
    await touchDrag(page, x, y, x, y + 90, 0);
    const down = await grid.evaluate((node) => node.scrollTop);
    expect(down).toBeLessThan(mid.top - 30);
    expect(await lunch.getAttribute("aria-label")).toBe(before);
    await touchDrag(page, x, y, x, y - 90, 0);
    const up = await grid.evaluate((node) => node.scrollTop);
    expect(up).toBeGreaterThan(down + 30);
    expect(await lunch.getAttribute("aria-label")).toBe(before);
  }
  await grid.evaluate((node) => { node.scrollTop = 40; });
  const tapped = await lunch.boundingBox();
  if (!tapped) throw new Error("lunch left the grid");
  const tx = tapped.x + 20;
  const ty = Math.min(gridBox.y + gridBox.height - 16, Math.max(gridBox.y + 16, tapped.y + 16));
  const tapHit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return node instanceof HTMLElement ? node.closest("button")?.getAttribute("aria-label") ?? null : null;
  }, { x: tx, y: ty });
  expect(tapHit).toContain("Lunch w/ Sam");
  await lunch.tap();
  await expect(page.getByRole("heading", { name: "Lunch w/ Sam" })).toBeVisible();
});

test("Monday approval does not include other days' proposals", async ({ page }, testInfo) => {
  await press(page.getByRole("radio", { name: /^Mon/ }), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Mon, Nov 9" })).toBeVisible();
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const gymBlock = block(page, "Gym");
  await gymBlock.scrollIntoViewIfNeeded();
  const gym = await center(gymBlock);
  await dragHold(page, gym.x, gym.y, gym.x, Math.min(gym.y + 70, (page.viewportSize()?.height ?? 800) - 24));
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await expect(page.getByTestId("plan-banner")).not.toContainText("agent suggests");
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await expect(page.getByRole("button", { name: "Approve all · 1 move" })).toBeVisible();
  await expect(page.getByRole("button", { name: /proposal/ })).toHaveCount(0);
  await expect(page.getByText("Budget sheet")).toHaveCount(0);
  await expect(page.getByText("Fix closet door")).toHaveCount(0);
});

test("Plan mode shows Review and Approve all for agent suggestions alone", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  const closet = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Fix closet door"));
  if (!budget || !closet) throw new Error("suggestions missing");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toContainText("Agent suggests 2");
  await expect(page.getByTestId("plan-banner")).not.toContainText("nothing saves until Review");
  await expect(page.getByRole("button", { name: "Review", exact: true })).toBeVisible();
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const approve = page.getByRole("button", { name: "Approve all · 2 proposals" });
  await expect(approve).toBeVisible();
  await press(approve, testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: [/Approved/],
    excludes: ["Undo"],
    proposals: [
      { id: budget.id, status: "approved" },
      { id: closet.id, status: "approved" },
    ],
  });
  expect(await page.getByTestId("plan-toast").getByRole("button", { name: "Undo" }).count()).toBe(0);
});

test("Plan enter keeps the current view", async ({ page }, testInfo) => {
  await press(page.getByTestId("plan-button"), testInfo.project.name);
  await expect(page.getByTestId("plan-banner")).toContainText("Agent suggests 2");
  await expect(page.getByTestId("plan-banner")).not.toContainText("nothing saves until Review");
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
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  await press(approve, testInfo.project.name);
  const approved = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: approved,
    includes: ["Approved 3 moves + 2 proposals"],
    blocks: staged.moves.map((move: { id: string; to: { start: string; end: string } }) => ({
      id: move.id,
      starts_at: move.to.start,
      ends_at: move.to.end,
    })),
  });
  const committed = await calendarState(page);
  for (const move of staged.moves) {
    const row = committed.blocks.find((item) => item.id === move.id);
    expect(Date.parse(row.starts_at)).toBe(Date.parse(move.to.start));
    expect(Date.parse(row.ends_at)).toBe(Date.parse(move.to.end));
  }
  expect(committed.proposals.filter((item) => item.kind === "calendar_block" && item.status === "pending")).toHaveLength(0);
  await expectOneLine(approved);
  await expectClearOfEvents(page, approved);
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
  const reverted = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: reverted,
    includes: ["Reverted. Nothing changed."],
    blocks: [{ title: "Call vendor", starts_at: "2026-11-10T15:00:00Z", ends_at: "2026-11-10T15:30:00Z" }],
  });
  await expectOneLine(reverted);
  await expectClearOfEvents(page, reverted);
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
  const nudged = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: nudged,
    includes: ["Call vendor → 10:15 AM"],
    blocks: [{ title: "Call vendor", starts_at: "2026-11-10T15:15:00Z", ends_at: "2026-11-10T15:45:00Z" }],
  });
  await expectOneLine(nudged);
  await expectClearOfEvents(page, nudged);
  await focusMatching(/^Undo$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Call vendor, Tue, Nov 10, 10:00/ })).toBeVisible();

  await focusMatching(/Budget sheet/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await focusMatching(/^Deny$/);
  await page.keyboard.press("Enter");
  const denied = page.getByTestId("plan-toast");
  const deniedState = await calendarState(page);
  const deniedBudget = deniedState.proposals.find((item) => item.kind === "calendar_block" && deniedState.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  if (!deniedBudget) throw new Error("budget missing");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: denied,
    includes: ["Denied · Budget sheet → Unscheduled"],
    proposals: [{ id: deniedBudget.id, status: "rejected" }],
  });
  await expectOneLine(denied);
  await expectClearOfEvents(page, denied);
  await expect(page.getByRole("button", { name: /Budget sheet/ })).toHaveCount(0);
});

test.describe("faces after the drop", () => {
  test.use({ reducedMotion: "no-preference" });

test("B1 week plan move + revert repaints immediately", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);

  async function painted(title: string) {
    await page.waitForTimeout(1000);
    const host = block(page, title);
    await expect(host).toBeVisible();
    const face = host.locator(".face");
    const text = host.locator("strong").first();
    await expect(text).toBeVisible();
    const hostBox = await host.boundingBox();
    const faceBox = await face.boundingBox();
    const textBox = await text.boundingBox();
    if (!hostBox || !faceBox || !textBox) throw new Error(`${title} has no painted face`);
    expect(hostBox.width).toBeGreaterThan(12);
    expect(faceBox.width).toBeGreaterThan(8);
    expect(faceBox.height).toBeGreaterThan(8);
    expect(textBox.width).toBeGreaterThan(4);
    expect(textBox.height).toBeGreaterThan(6);
    expect(textBox.x).toBeGreaterThanOrEqual(hostBox.x - 1);
    expect(textBox.x).toBeLessThan(hostBox.x + hostBox.width);
    expect(faceBox.x).toBeGreaterThanOrEqual(hostBox.x - 1);
    expect(faceBox.x).toBeLessThan(hostBox.x + hostBox.width);
  }

  const designAt = await center(block(page, "Design crit"));
  const spec = await center(block(page, "Spec review"));
  await uiDrag(page, testInfo.project.name, spec.x, spec.y, designAt.x, designAt.y);
  await expect(block(page, "Spec review")).toHaveAttribute("aria-label", /Thu/);
  await painted("Spec review");
  await painted("Design crit");

  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const budgetAt = await center(budget);
  const lunchAt = await center(block(page, "Lunch w/ Sam"));
  await uiDrag(page, testInfo.project.name, budgetAt.x, budgetAt.y, lunchAt.x, lunchAt.y);
  await painted("Budget sheet");
  await painted("Lunch w/ Sam");

  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await expect(block(page, "Spec review")).toHaveAttribute("aria-label", /Tue/);
  await painted("Spec review");
  await painted("Budget sheet");
  await expect(budget).toHaveAttribute("aria-label", /Proposed/);
  const star = budget.locator(".corner");
  await expect(star).toBeVisible();
  await expect(budget).toContainText("Budget");

  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const specAgain = await center(block(page, "Spec review"));
  const designAgain = await center(block(page, "Design crit"));
  await uiDrag(page, testInfo.project.name, specAgain.x, specAgain.y, designAgain.x, designAgain.y);
  const stagedSpec = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: [/Approved/],
    blocks: stagedSpec.moves.map((move: { id: string; to: { start: string; end: string } }) => ({
      id: move.id,
      starts_at: move.to.start,
      ends_at: move.to.end,
    })),
  });
  await expect(block(page, "Spec review")).toHaveAttribute("aria-label", /Thu/);
  await painted("Spec review");
});

test("B6 week proposal face stays painted", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const at = await center(budget);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x, at.y + 70);
  await page.waitForTimeout(1000);
  const face = budget.locator(".face");
  const title = budget.locator("strong").first();
  const faceBox = await face.boundingBox();
  const titleBox = await title.boundingBox();
  expect(faceBox?.width).toBeGreaterThan(8);
  expect(faceBox?.height).toBeGreaterThan(8);
  expect(titleBox?.width).toBeGreaterThan(4);
  expect(titleBox?.height).toBeGreaterThan(6);
  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await page.waitForTimeout(1000);
  const restored = await budget.locator(".face").boundingBox();
  expect(restored?.width).toBeGreaterThan(8);
  expect(restored?.height).toBeGreaterThan(8);
  await expect(budget).toHaveAttribute("aria-label", /Proposed/);
});
});

test("B2 week and day overlaps stay side by side", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  const design = await block(page, "Design crit").boundingBox();
  const coffee = await block(page, "Coffee w/ Jo").boundingBox();
  if (!design || !coffee) throw new Error("thursday pair missing");
  expect(design.width).toBeGreaterThan(12);
  expect(coffee.width).toBeGreaterThan(12);
  expect(design.x + design.width).toBeLessThanOrEqual(coffee.x + 1);
  await expect(block(page, "Design crit")).toContainText("Design");
  await expect(block(page, "Coffee w/ Jo")).toContainText("Coffee");

  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Day" }), testInfo.project.name);
  const spec = await block(page, "Spec review").boundingBox();
  const vendor = await block(page, "Call vendor").boundingBox();
  if (!spec || !vendor) throw new Error("tuesday pair missing");
  expect(spec.width).toBeGreaterThan(40);
  expect(vendor.width).toBeGreaterThan(40);
  expect(spec.x + spec.width).toBeLessThanOrEqual(vendor.x + 1);
});

test("B3 calendar toggle keeps the week title wrap", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  const design = block(page, "Design crit");
  const before = await titleLayout(design);
  expect(before.texts.join("")).toContain("Design");
  expect(before.block.width).toBeGreaterThan(8);
  await press(page.getByTestId("more-button"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: /Show/ }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Personal" }), testInfo.project.name);
  await expect(block(page, "Coffee w/ Jo")).toHaveCount(0);
  const after = await titleLayout(design);
  expect(after.texts).toEqual(before.texts);
  expect(after.lines.length).toBe(before.lines.length);
  expect(after.block.width).toBeGreaterThan(before.block.width + 4);
  if (testInfo.project.name === "phone" || testInfo.project.name === "s23") {
    expect(before.lines.length).toBeGreaterThan(1);
    expect(after.lines[1].y).toBeGreaterThanOrEqual(after.lines[0].y + after.lines[0].height - 1);
  }
});

test("B4 tray info tap and grip drag", async ({ page }, testInfo) => {
  const grid = page.getByTestId("day-grid");
  const before = await grid.boundingBox();
  await press(page.getByTestId("sync-chip"), testInfo.project.name);
  const sheet = page.getByTestId("tray-sheet");
  await expect(sheet).toHaveAttribute("data-open", "1");
  await expect(sheet).toHaveCSS("transition-duration", "0s");
  const trayBar = () => page.locator(".v3-tray .tray-grip").evaluate((node) => getComputedStyle(node, "::before").visibility);
  expect(await trayBar()).toBe("hidden");
  const bars = await page.evaluate(() => {
    const names: string[] = [];
    for (const node of document.querySelectorAll(".tray-grip")) {
      const before = getComputedStyle(node, "::before");
      const rect = node.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
      const shown = before.content !== "none" && before.visibility === "visible" && Number.parseFloat(before.width) > 0;
      if (onScreen && shown) names.push(node.getAttribute("data-testid") || "grip");
    }
    return names;
  });
  expect(bars).toEqual(["tray-sheet-grip"]);
  await expect(sheet.getByText("Buy stamps")).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Demo · not synced" })).toBeVisible();
  const after = await grid.boundingBox();
  if (!before || !after) throw new Error("grid missing");
  expect(after.height).toBeCloseTo(before.height, 0);
  expect(after.y).toBeCloseTo(before.y, 0);

  const grip = page.getByTestId("tray-grip");
  const gripBox = await grip.boundingBox();
  if (!gripBox) throw new Error("grip missing");
  expect(gripBox.height).toBeGreaterThanOrEqual(44);
  expect(gripBox.width).toBeGreaterThanOrEqual(44);
  const x = gripBox.x + gripBox.width / 2;
  const y = gripBox.y + gripBox.height / 2;
  await dragGrip(page, testInfo.project.name, x, y, 80);
  await expect(sheet).toHaveAttribute("data-open", "0");
  expect(await trayBar()).toBe("visible");

  await dragGrip(page, testInfo.project.name, x, y, -80);
  await expect(sheet).toHaveAttribute("data-open", "1");
  const handle = page.getByTestId("tray-sheet-grip");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("sheet grip missing");
  expect(handleBox.height).toBeGreaterThanOrEqual(28);
  expect(handleBox.width).toBeGreaterThan(40);
  await expect(handle).toHaveCSS("touch-action", "none");
  await dragGrip(page, testInfo.project.name, handleBox.x + handleBox.width / 2, handleBox.y + 12, 200);
  await expect(sheet).toHaveAttribute("data-open", "0");
  await press(page.getByTestId("sync-chip"), testInfo.project.name);
  await expect(sheet).toHaveAttribute("data-open", "1");
  await expect(sheet).not.toContainText("NOT synced");
  await expect(page.getByTestId("unscheduled")).toContainText("Unscheduled");
  await expect(page.getByTestId("sync-chip")).toContainText("Demo · not synced");

  const scrim = await page.getByTestId("tray-scrim").boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!scrim || !sheetBox) throw new Error("scrim missing");
  const outside = { x: scrim.x + scrim.width / 2, y: sheetBox.y - 16 };
  expect(outside.y).toBeGreaterThan(scrim.y);
  expect(outside.y).toBeLessThan(sheetBox.y);
  if (testInfo.project.name === "desktop") await page.mouse.click(outside.x, outside.y);
  else await page.touchscreen.tap(outside.x, outside.y);
  await expect(sheet).toHaveAttribute("data-open", "0");
  await expect(page.getByRole("heading", { name: "Call vendor" })).toHaveCount(0);
});

test("E3 a tap in the calendar's bottom band opens the event", async ({ page }, testInfo) => {
  const tray = await page.locator(".v3-tray").boundingBox();
  const grip = await page.getByTestId("tray-grip").boundingBox();
  const grid = await page.getByTestId("day-grid").boundingBox();
  if (!tray || !grip || !grid) throw new Error("tray missing");
  expect(grip.y).toBeGreaterThanOrEqual(tray.y - 1);
  expect(grip.y).toBeGreaterThanOrEqual(grid.y + grid.height - 1);
  const target = await page.evaluate(() => {
    const scroller = document.querySelector(".v3-grid");
    const blocks = [...document.querySelectorAll(".v3-grid .block")];
    if (!(scroller instanceof HTMLElement) || blocks.length === 0) return null;
    const lowest = blocks.reduce((best, node) => {
      const box = node.getBoundingClientRect();
      return !best || box.bottom > best.getBoundingClientRect().bottom ? node : best;
    }, null as Element | null);
    if (!(lowest instanceof HTMLElement)) return null;
    const gridRect = scroller.getBoundingClientRect();
    const blockRect = lowest.getBoundingClientRect();
    scroller.scrollTop += blockRect.bottom - (gridRect.bottom - 20);
    const next = lowest.getBoundingClientRect();
    const y = Math.min(next.bottom - 8, gridRect.bottom - 12);
    return {
      x: next.left + Math.min(next.width / 2, 28),
      y,
      title: (lowest.getAttribute("aria-label") || "").split(",")[0],
      id: lowest.getAttribute("data-testid"),
    };
  });
  if (!target) throw new Error("no event in the bottom band");
  const owner = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    const block = node instanceof Element ? node.closest(".block") : null;
    const gripHit = node instanceof Element ? node.closest("[data-testid='tray-grip']") : null;
    return { block: block?.getAttribute("data-testid") || "", grip: Boolean(gripHit) };
  }, target);
  expect(owner.grip).toBe(false);
  expect(owner.block).toBe(target.id);
  if (testInfo.project.name === "desktop") await page.mouse.click(target.x, target.y);
  else await page.touchscreen.tap(target.x, target.y);
  await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
  await expect(page.getByTestId("tray-sheet")).toHaveAttribute("data-open", "0");
});

test("B5 week block opens in place and the header opens the day", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(block(page, "Design crit"), testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Design crit" })).toBeVisible();
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "week");
  await page.keyboard.press("Escape");
  await press(page.locator(".week-head").filter({ hasText: "12" }), testInfo.project.name);
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "day");
  await expect(page.getByRole("heading", { name: "Thu, Nov 12" })).toBeVisible();
});

test("B6 moving a proposal decides it and revert restores it", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const at = await center(budget);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x, at.y + 70);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await expect(page.getByTestId("plan-banner")).toContainText("agent suggests 1");
  await expect(budget).not.toHaveAttribute("aria-label", /Proposed/);
  await press(budget, testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Budget sheet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await expect(block(page, "Budget sheet")).not.toHaveAttribute("aria-label", /Proposed/);
  await press(page.getByRole("button", { name: "Revert" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await expect(block(page, "Budget sheet")).toHaveAttribute("aria-label", /Proposed/);
  await page.reload();
  await expect(block(page, "Budget sheet")).toHaveAttribute("aria-label", /Proposed/);
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
});

const calendarState = readCalendar;

test("V1 a moved proposal leaves the list and the counts agree", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const at = await center(budget);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x, at.y + 70);
  const banner = page.getByTestId("plan-banner");
  await expect(banner).toContainText("1 move");
  await expect(banner).toContainText("agent suggests 1");
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const dialog = page.getByRole("dialog", { name: "Review plan" });
  await expect(dialog).toContainText("YOUR MOVES · 1");
  await expect(dialog).toContainText("AGENT PROPOSAL · 1");
  await expect(dialog.getByRole("button", { name: /Approve all/ })).toHaveText("Approve all · 1 move + 1 proposal");
  await expect(dialog).toContainText("Budget sheet");
  await expect(dialog).not.toContainText("Proposed · Tue 2:00–3:30 PM");
  await expect(dialog).toContainText("Proposed · Tue 5:00–6:00 PM");
});

test("N1 the approve toast matches the review classification", async ({ page }, testInfo) => {
  const before = await calendarState(page);
  const specBefore = before.blocks.find((item) => item.title === "Spec review");
  if (!specBefore) throw new Error("spec missing");
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const specAt = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, specAt.x, specAt.y, specAt.x + column, specAt.y);
  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const budgetAt = await center(budget);
  await uiDrag(page, testInfo.project.name, budgetAt.x, budgetAt.y, budgetAt.x, budgetAt.y + 70);
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const specMove = staged.moves.find((item: { id: string }) => item.id === specBefore.id);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const button = page.getByRole("button", { name: /Approve all/ });
  await expect(button).toHaveText("Approve all · 2 moves + 1 proposal");
  const review = (await button.innerText()).replace(/\s+/g, " ").trim();
  await press(button, testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  const toastText = await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Approved 2 moves + 1 proposal"],
    blocks: [{ id: specBefore.id, starts_at: specMove.to.start, ends_at: specMove.to.end }],
  });
  expect(toastText.replace(/^Approved /, "")).toBe(review.replace(/^Approve all · /, ""));
});

test("V2 approve all persists and the toast matches the server", async ({ page }, testInfo) => {
  const before = await calendarState(page);
  const specBefore = before.blocks.find((item) => item.title === "Spec review");
  if (!specBefore) throw new Error("spec missing");
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await expect(page.locator(".v3")).toHaveAttribute("data-mode", "week");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x + column, at.y);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const stagedSpec = staged.moves.find((item: { id: string }) => item.id === specBefore.id);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  const toastText = await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: [/Approved 1 move/],
    blocks: [{ id: specBefore.id, starts_at: stagedSpec.to.start, ends_at: stagedSpec.to.end }],
  });

  async function agreed() {
    const state = await calendarState(page);
    const specRow = state.blocks.find((item) => item.title === "Spec review" && item.status === "scheduled");
    if (!specRow) throw new Error("spec missing after approve");
    expect(specRow.starts_at).not.toBe(specBefore.starts_at);
    expect(Date.parse(specRow.starts_at)).toBe(Date.parse(stagedSpec.to.start));
    if (await page.locator(".v3").getAttribute("data-mode") !== "week") {
      await press(page.getByTestId("view-switch"), testInfo.project.name);
      await press(page.getByRole("menuitem", { name: "Week", exact: true }), testInfo.project.name);
    }
    const label = await block(page, "Spec review").getAttribute("aria-label");
    expect(label).toContain(uiWhen(specRow.starts_at));
    let approved = 0;
    for (const title of ["Budget sheet", "Fix closet door"]) {
      const task = state.tasks.find((item) => item.title === title);
      const proposal = state.proposals.find((item) => item.kind === "calendar_block" && item.payload.task_id === task?.id);
      const row = state.blocks.find((item) => item.title === title && item.status === "scheduled");
      const eventLabel = await block(page, title).getAttribute("aria-label");
      if (proposal?.status === "pending") expect(eventLabel).toMatch(/Proposed/);
      else expect(eventLabel).not.toMatch(/Proposed/);
      if (row) expect(eventLabel).toContain(uiWhen(row.starts_at));
      if (proposal?.status === "approved") approved += 1;
    }
    const claimedMoves = Number(/Approved (\d+) move/.exec(toastText)?.[1] ?? 0);
    const claimedProposals = Number(/\+ (\d+) proposal/.exec(toastText)?.[1] ?? 0);
    expect(toastText.startsWith("Approved")).toBe(true);
    expect(claimedMoves).toBe(1);
    expect(claimedProposals).toBe(approved);
    expect(approved).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2"))).toBeNull();
  }

  await agreed();
  await page.reload();
  await agreed();
});

test("R1 a failed calendar write stays in the plan", async ({ page }, testInfo) => {
  const before = await calendarState(page);
  const specBefore = before.blocks.find((item) => item.title === "Spec review");
  const closetBefore = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Fix closet door"));
  if (!specBefore || !closetBefore) throw new Error("fixture missing");
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x + column, at.y);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await armWriteFailure(page, [specBefore.id]);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  const rendered = await checkSaveClaim(page, {
    case: "forced-failure",
    toast,
    includes: ["Saved 2 of 3 · Spec review still in plan"],
    excludes: ["Nothing was changed"],
    blocks: [{ id: specBefore.id, starts_at: specBefore.starts_at }],
    proposals: [{ id: closetBefore.id, status: "approved" }],
  });
  expect(rendered).toContain("Saved 2 of 3 · Spec review still in plan");
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  expect(draft.moves.map((item: { id: string }) => item.id)).toEqual([specBefore.id]);
  expect(draft.active).toBe(true);
  if (testInfo.project.name === "s23") {
    const keep = page.getByTestId("toast-keep");
    await expect(keep).toBeVisible();
    await expect(keep).toHaveText("still in plan");
    const clip = await keep.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(clip.sw).toBeLessThanOrEqual(clip.cw);
    await expect(page.getByTestId("plan-toast").locator(".toast-icon")).toHaveAttribute("data-icon", "info");
  }
});

test("R4 client skips a Changed move and keeps the newer time", async ({ page }, testInfo) => {
  const before = await calendarState(page);
  const specBefore = before.blocks.find((item) => item.title === "Spec review");
  if (!specBefore) throw new Error("spec missing");
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x + column, at.y);
  await armWriteFailure(page, [specBefore.id]);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "forced-failure",
    toast: page.getByTestId("plan-toast"),
    includes: ["Spec review still in plan"],
    blocks: [{ id: specBefore.id, starts_at: specBefore.starts_at }],
  });
  const newerStart = "2026-11-11T18:00:00Z";
  const newerEnd = "2026-11-11T19:30:00Z";
  const changed = await page.evaluate(async (body) => {
    const response = await fetch("/api/decisions/plan/commit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-TAFO-Actor": "human" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, text: await response.text() };
  }, {
    confirmed: true,
    moves: [{
      block_id: specBefore.id,
      expected_version: specBefore.version,
      starts_at: newerStart,
      ends_at: newerEnd,
      idempotency_key: "r4-newer-spec",
      title: "Spec review",
    }],
    approvals: [],
  });
  expect(changed.ok, changed.text).toBeTruthy();
  await page.reload();
  if (testInfo.project.name === "s23") await expect(page.getByTestId("plan-conflict")).toHaveText("1 changed");
  else await expect(page.getByTestId("plan-conflict")).toContainText("Changed · Spec review");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/decisions/plan/commit")) posts.push(request.postData() || "");
  });
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await expect(page.getByTestId("changed-tag")).toHaveText("Changed");
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: ["Spec review changed, so nothing was saved"],
    excludes: ["Approved"],
    blocks: [{ id: specBefore.id, starts_at: newerStart, ends_at: newerEnd }],
  });
  expect(posts.some((body) => body.includes(specBefore.id))).toBe(false);
});

test("R5 unsynced moved proposal does not block healthy moves", async ({ page }, testInfo) => {
  const before = await calendarState(page);
  const vendor = before.blocks.find((item) => item.title === "Call vendor");
  const budgetProposal = before.proposals.find((item) => item.kind === "calendar_block" && before.tasks.some((task) => task.id === item.payload.task_id && task.title === "Budget sheet"));
  if (!vendor || !budgetProposal) throw new Error("fixture missing");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const budget = block(page, "Budget sheet");
  await budget.scrollIntoViewIfNeeded();
  const at = await center(budget);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x, at.y + 60);
  await armWriteFailure(page, [], 1);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  const failed = page.getByTestId("plan-toast");
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const budgetMove = draft.moves.find((item: { title: string }) => item.title === "Budget sheet");
  await checkSaveClaim(page, {
    case: "failure-then-retry",
    toast: failed,
    includes: ["Budget sheet", "still in plan"],
    excludes: ["not pending", "Changed"],
    proposals: [{ id: budgetProposal.id, status: "approved" }],
    retry: async () => {
      const call = block(page, "Call vendor");
      await call.scrollIntoViewIfNeeded();
      const from = await center(call);
      await dragHold(page, from.x, from.y, from.x, from.y + 60);
      await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
      await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
    },
    afterRetry: {
      toast: page.getByTestId("plan-toast"),
      includes: [/Approved/],
      excludes: ["not pending", "Nothing was saved", "Changed"],
      proposals: [{ id: budgetProposal.id, status: "approved" }],
      blocks: [
        { id: vendor.id, starts_at: "2026-11-10T16:00:00Z", ends_at: "2026-11-10T16:30:00Z" },
        { taskTitle: "Budget sheet", starts_at: budgetMove.to.start, ends_at: budgetMove.to.end },
      ],
    },
  });
  expect(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2"))).toBeNull();
  await expect(page.getByTestId("plan-conflict")).toHaveCount(0);
});

test("V3 a failed confirmation read still drops saved moves", async ({ page }, testInfo) => {
  let commitLanded = false;
  const failRead = async (route: Route) => {
    if (commitLanded && route.request().method() === "GET") {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{\"detail\":\"down\"}" });
      return;
    }
    await route.continue();
  };
  await page.route("**/api/calendar/blocks", failRead);
  await page.route("**/api/hermes/proposals", failRead);
  page.on("response", (response) => {
    if (response.url().includes("/api/decisions/plan/commit") && response.status() === 200) commitLanded = true;
  });
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x + column, at.y);
  const lunch = block(page, "Lunch w/ Sam");
  const lunchAt = await center(lunch);
  await uiDrag(page, testInfo.project.name, lunchAt.x, lunchAt.y, lunchAt.x + column, lunchAt.y);
  await expect(page.getByTestId("plan-banner")).toContainText("2 moves");
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toBeVisible();
  await page.unroute("**/api/calendar/blocks");
  await page.unroute("**/api/hermes/proposals");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Saved · refreshing the calendar"],
    excludes: ["unsaved", "Nothing was changed"],
    blocks: staged.moves.map((move: { id: string; to: { start: string; end: string } }) => ({
      id: move.id,
      starts_at: move.to.start,
      ends_at: move.to.end,
    })),
  });
  expect(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2"))).toBeNull();
  await page.reload();
  await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  const after = await calendarState(page);
  for (const move of staged.moves) {
    const row = after.blocks.find((item) => item.id === move.id);
    expect(Date.parse(row?.starts_at || "")).toBe(Date.parse(move.to.start));
    const label = await block(page, move.title).getAttribute("aria-label");
    expect(label).toContain(uiWhen(row?.starts_at || ""));
  }
  expect(after.proposals.filter((item) => item.kind === "calendar_block" && item.status === "pending")).toHaveLength(0);
});

async function rawTouchTap(page: Page, x: number, y: number) {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 0, radiusX: 1, radiusY: 1 }],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

test("V3 touch double-tap of two moves commits once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "desktop has no touch screen");
  let commits = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/decisions/plan/commit")) commits += 1;
  });
  await page.evaluate(() => {
    const record = (name: string) => {
      const log = (window as unknown as { __taps?: string[] });
      log.__taps = log.__taps || [];
      log.__taps.push(name);
    };
    document.addEventListener("pointerup", () => record("pointerup"), true);
    document.addEventListener("click", () => record("click"), true);
    document.addEventListener("touchend", () => record("touchend"), true);
  });
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const specAt = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, specAt.x, specAt.y, specAt.x + column, specAt.y);
  const lunch = block(page, "Lunch w/ Sam");
  await lunch.scrollIntoViewIfNeeded();
  const lunchAt = await center(lunch);
  await uiDrag(page, testInfo.project.name, lunchAt.x, lunchAt.y, lunchAt.x + column, lunchAt.y);
  await expect(page.getByTestId("plan-banner")).toContainText("2 moves");
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const approve = page.getByTestId("approve-all");
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox();
  if (!box) throw new Error("approve missing");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (testInfo.project.name === "s23") {
    await rawTouchTap(page, x, y);
    await page.waitForTimeout(100);
    await rawTouchTap(page, x, y);
  } else {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(100);
    await page.touchscreen.tap(x, y);
  }
  const toast = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: [/Approved/],
    excludes: ["still in plan", "Nothing was saved"],
    blocks: staged.moves.map((move: { id: string; to: { start: string; end: string } }) => ({
      id: move.id,
      starts_at: move.to.start,
      ends_at: move.to.end,
    })),
  });
  expect(commits).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2"))).toBeNull();
});

test("V3 touch double-tap on Approve all commits once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "desktop has no touch screen");
  let commits = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/decisions/plan/commit")) commits += 1;
  });
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const vendor = await center(block(page, "Call vendor,"));
  await dragHold(page, vendor.x, vendor.y, vendor.x, vendor.y + 60);
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  const sheet = page.getByTestId("review-sheet");
  await expect(sheet).toBeVisible();
  const approve = page.getByTestId("approve-all");
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox();
  if (!box) throw new Error("approve missing");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(56);
  await page.touchscreen.tap(x, y);
  const toast = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: [/Approved|Saved/],
    excludes: ["changed"],
    blocks: [{ id: staged.moves[0].id, starts_at: staged.moves[0].to.start, ends_at: staged.moves[0].to.end }],
  });
  expect(commits).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2"))).toBeNull();
});

test("R2 a stale draft does not overwrite a newer block", async ({ page }, testInfo) => {
  await press(page.getByTestId("view-switch"), testInfo.project.name);
  await press(page.getByRole("menuitem", { name: "Week" }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  const spec = block(page, "Spec review");
  await spec.scrollIntoViewIfNeeded();
  const at = await center(spec);
  const column = await page.locator(".workband").first().evaluate((node) => node.getBoundingClientRect().width);
  await uiDrag(page, testInfo.project.name, at.x, at.y, at.x + column, at.y);
  await expect(page.getByTestId("plan-banner")).toContainText("1 move");
  await page.reload();
  const staged = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const before = await calendarState(page);
  const specBefore = before.blocks.find((item) => item.title === "Spec review");
  if (!specBefore) throw new Error("spec missing");
  const shifted = new Date(Date.parse(specBefore.starts_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const shiftedEnd = new Date(Date.parse(specBefore.ends_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const changed = await page.evaluate(async (body) => {
    const response = await fetch("/api/decisions/plan/commit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-TAFO-Actor": "human" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, {
    confirmed: true,
    moves: [{
      block_id: specBefore.id,
      expected_version: specBefore.version,
      starts_at: shifted,
      ends_at: shiftedEnd,
      idempotency_key: "r2-server-change-spec",
      title: "Spec review",
    }],
    approvals: [],
  });
  expect(changed.ok, changed.text).toBeTruthy();
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: /Approve all/ }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Spec review changed, so nothing was saved"],
    excludes: ["Approved"],
    blocks: [{ id: specBefore.id, starts_at: shifted, ends_at: shiftedEnd }],
  });
  const after = await calendarState(page);
  const specRow = after.blocks.find((item) => item.id === specBefore.id);
  expect(Date.parse(specRow?.starts_at || "")).toBe(Date.parse(shifted));
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  expect(draft.moves.map((item: { id: string }) => item.id)).toEqual([specBefore.id]);
  expect(draft.moves[0].version).toBe(staged.moves[0].version);
  if (testInfo.project.name === "s23") {
    await expect(page.getByTestId("plan-conflict")).toHaveText("1 changed");
    await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
    await expect(page.getByTestId("changed-tag")).toHaveText("Changed");
  } else {
    await expect(page.getByTestId("plan-conflict")).toContainText("Changed · Spec review");
  }
});

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the tray sheet eases open", async ({ page }) => {
    const duration = await page.locator(".tray-sheet").evaluate((node) => getComputedStyle(node).transitionDuration);
    expect(duration).not.toBe("0s");
    await page.getByTestId("sync-chip").click();
    await expect(page.getByTestId("tray-sheet")).toHaveAttribute("data-open", "1");
    const grid = await page.getByTestId("day-grid").boundingBox();
    expect(grid?.height).toBeGreaterThan(100);
  });

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
