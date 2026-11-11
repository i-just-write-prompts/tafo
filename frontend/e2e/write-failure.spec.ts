/* Forced-write failures for every approval path.
   Sync: a refused write is not "saved", and it is not stranded.
   Proposals: an approved suggestion with no block stays visible, including after Revert all. */
import { expect, test, type Page } from "@playwright/test";

import { armWriteFailure, checkSaveClaim, readCalendar, type CalendarBlockRow, type ProposalRow } from "./helpers/saveClaim";
import { block, center, dragHold, openDay, press, reseed } from "./support";

test.beforeEach(async ({ page, request }) => {
  await reseed(request);
  await openDay(page);
});

async function touchDrag(page: Page, fromX: number, fromY: number, toX: number, toY: number) {
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
  await client.detach();
}

async function uiDrag(page: Page, project: string, fromX: number, fromY: number, toX: number, toY: number) {
  if (project === "s23") await touchDrag(page, fromX, fromY, toX, toY);
  else await dragHold(page, fromX, fromY, toX, toY);
}

function proposalNamed(state: Awaited<ReturnType<typeof readCalendar>>, title: string): ProposalRow {
  const task = state.tasks.find((item) => item.title === title);
  const row = state.proposals.find((item) => item.kind === "calendar_block" && item.payload.task_id === task?.id);
  if (!task || !row) throw new Error(`${title} missing`);
  return row;
}

function scheduledFor(blocks: CalendarBlockRow[], taskId: string): CalendarBlockRow | undefined {
  return blocks.find((item) => item.task_id === taskId && item.status === "scheduled");
}

async function dragTitle(page: Page, project: string, title: string, dy: number) {
  const target = block(page, title);
  await target.scrollIntoViewIfNeeded();
  const at = await center(target);
  await uiDrag(page, project, at.x, at.y, at.x, at.y + dy);
}

async function statusFits(page: Page, status: RegExp | string) {
  const keep = page.locator("[data-testid=toast-keep]");
  await expect(keep).toBeVisible();
  await expect(keep).toHaveText(status);
  const clip = await keep.evaluate((el) => {
    const node = el as HTMLElement;
    return { sw: node.scrollWidth, cw: node.clientWidth, sh: node.parentElement?.scrollHeight ?? 0, ch: node.parentElement?.clientHeight ?? 0 };
  });
  expect(clip.sw).toBeLessThanOrEqual(clip.cw + 1);
  expect(clip.sh).toBeLessThanOrEqual(clip.ch + 1);
}

test("PR1 a refused quick drag stays visible with Retry", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const taskId = budget.payload.task_id || "";
  await armWriteFailure(page, [], 1);
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  await page.locator("[data-testid=plan-toast]").waitFor();
  const edited = await readCalendar(page);
  const row = edited.proposals.find((item) => item.id === budget.id);
  const start = row?.edited_payload?.starts_at || row?.payload.starts_at || "";
  const end = row?.edited_payload?.ends_at || row?.payload.ends_at || "";
  expect(start, "the drag edited the proposal").not.toBe("");
  expect(scheduledFor(edited.blocks, taskId), "failed create inserts no block").toBeUndefined();
  await checkSaveClaim(page, {
    case: "failure-then-retry",
    toast: page.getByTestId("plan-toast"),
    includes: ["not on calendar"],
    excludes: ["didn't move", "→"],
    proposals: [{ id: budget.id, status: "approved" }],
    retry: async () => {
      await expect(page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Retry" })).toBeVisible();
      expect(await page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Undo" }).count()).toBe(0);
      await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
      const marker = page.getByRole("button", { name: /Budget sheet/ });
      await expect(marker).toHaveAttribute("aria-label", /Not on calendar/);
      await press(marker, testInfo.project.name);
      await press(page.getByTestId("unplaced-retry"), testInfo.project.name);
    },
    afterRetry: {
      toast: page.getByTestId("plan-toast"),
      includes: ["→"],
      proposals: [{ id: budget.id, status: "approved" }],
      blocks: [{ taskTitle: "Budget sheet", starts_at: start, ends_at: end }],
    },
  });
});

test("decide a refused Approve stays visible with Retry", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const taskId = budget.payload.task_id || "";
  const start = budget.payload.starts_at || "";
  const end = budget.payload.ends_at || "";
  await press(block(page, "Budget sheet"), testInfo.project.name);
  await armWriteFailure(page, [], 1);
  await press(page.getByRole("button", { name: "Approve", exact: true }), testInfo.project.name);
  const edited = await readCalendar(page);
  expect(scheduledFor(edited.blocks, taskId)).toBeUndefined();
  await checkSaveClaim(page, {
    case: "failure-then-retry",
    toast: page.getByTestId("plan-toast"),
    includes: ["not on calendar"],
    excludes: ["didn't move", "→", "Approved Budget"],
    proposals: [{ id: budget.id, status: "approved" }],
    retry: async () => {
      await expect(page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Retry" })).toBeVisible();
      expect(await page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Undo" }).count()).toBe(0);
      await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
      const marker = page.getByRole("button", { name: /Budget sheet/ });
      await expect(marker).toHaveAttribute("aria-label", /Not on calendar/);
      await press(marker, testInfo.project.name);
      await press(page.getByTestId("unplaced-retry"), testInfo.project.name);
    },
    afterRetry: {
      toast: page.getByTestId("plan-toast"),
      includes: ["→"],
      proposals: [{ id: budget.id, status: "approved" }],
      blocks: [{ taskTitle: "Budget sheet", starts_at: start, ends_at: end }],
    },
  });
});

test("Approve all a refused proposal shows Retry and stays visible", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const taskId = budget.payload.task_id || "";
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const move = draft.moves.find((item: { title: string }) => item.title === "Budget sheet");
  await armWriteFailure(page, [], 1);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "failure-then-retry",
    toast: page.getByTestId("plan-toast"),
    includes: ["Budget sheet", "still in plan"],
    excludes: ["→", "didn't move"],
    proposals: [{ id: budget.id, status: "approved" }],
    retry: async () => {
      await expect(page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Retry" })).toBeVisible();
      expect(await page.locator("[data-testid=plan-toast]").getByRole("button", { name: "Undo" }).count()).toBe(0);
      await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
      const marker = page.getByRole("button", { name: /Budget sheet/ });
      await expect(marker).toHaveAttribute("aria-label", /Not on calendar/);
      await press(marker, testInfo.project.name);
      await press(page.getByTestId("unplaced-retry"), testInfo.project.name);
    },
    afterRetry: {
      toast: page.getByTestId("plan-toast"),
      includes: ["→"],
      proposals: [{ id: budget.id, status: "approved" }],
      blocks: [{ taskTitle: "Budget sheet", starts_at: move.to.start, ends_at: move.to.end }],
    },
  });
  expect(scheduledFor((await readCalendar(page)).blocks, taskId)).toBeTruthy();
});

test("plan commit a refused block move stays on the calendar", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const vendor = before.blocks.find((item) => item.title === "Call vendor" && item.status === "scheduled");
  if (!vendor) throw new Error("vendor missing");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Call vendor", 60);
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const move = draft.moves.find((item: { id: string }) => item.id === vendor.id);
  await armWriteFailure(page, [vendor.id]);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "failure-then-retry",
    toast: page.getByTestId("plan-toast"),
    includes: ["still in plan"],
    excludes: ["→"],
    blocks: [{ id: vendor.id, starts_at: vendor.starts_at, ends_at: vendor.ends_at }],
    retry: async () => {
      await expect(block(page, "Call vendor")).toBeVisible();
      await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
      await press(page.getByTestId("approve-all"), testInfo.project.name);
    },
    afterRetry: {
      toast: page.getByTestId("plan-toast"),
      includes: [/Approved/],
      blocks: [{ id: vendor.id, starts_at: move.to.start, ends_at: move.to.end }],
    },
  });
});

test("after a failed approve, Revert all keeps Not on calendar with Retry", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const taskId = budget.payload.task_id || "";
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem("tafo.v3.plan.v2") || "null"));
  const move = draft.moves.find((item: { title: string }) => item.title === "Budget sheet");
  await armWriteFailure(page, [], 1);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "forced-failure",
    toast: page.getByTestId("plan-toast"),
    includes: ["still in plan"],
    proposals: [{ id: budget.id, status: "approved" }],
  });
  await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
  await press(page.getByRole("button", { name: "Revert", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "forced-failure",
    toast: page.getByTestId("plan-toast"),
    includes: ["Reverted", "not on calendar"],
    excludes: ["Nothing changed", "→"],
    proposals: [{ id: budget.id, status: "approved" }],
  });
  await expect(page.locator("[data-testid=plan-toast] .toast-icon")).toHaveAttribute("data-icon", "info");
  await statusFits(page, /not on calendar/);
  const hidden = await readCalendar(page);
  expect(hidden.proposals.find((item) => item.id === budget.id)?.status).toBe("approved");
  expect(scheduledFor(hidden.blocks, taskId), "Revert all must not hide an approved proposal that has no block").toBeUndefined();
  await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
  const marker = page.getByRole("button", { name: /Budget sheet/ });
  await expect(marker).toHaveAttribute("aria-label", /Not on calendar/);
  await press(marker, testInfo.project.name);
  await press(page.getByTestId("unplaced-retry"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: ["→"],
    proposals: [{ id: budget.id, status: "approved" }],
    blocks: [{ taskTitle: "Budget sheet", starts_at: move.to.start, ends_at: move.to.end }],
  });
});

test("Not on calendar Retry is a full-width secondary button", async ({ page }, testInfo) => {
  await armWriteFailure(page, [], 1);
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
  const marker = page.getByRole("button", { name: /Budget sheet/ });
  await expect(marker).toHaveAttribute("aria-label", /Not on calendar/);
  await press(marker, testInfo.project.name);
  const retry = page.getByTestId("unplaced-retry");
  const sheet = page.getByRole("dialog", { name: "Budget sheet" });
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("Retry");
  const box = await retry.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!box || !sheetBox) throw new Error("retry box missing");
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(sheetBox.width - 36);
  const paint = await retry.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(paint).not.toBe("rgb(237, 238, 240)");
  expect(paint).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint).not.toBe("transparent");
});

test("a Proposed quick drag toast has no Undo", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const taskId = budget.payload.task_id || "";
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("→");
  expect(await toast.getByRole("button", { name: "Undo" }).count()).toBe(0);
  const saved = await readCalendar(page);
  const landed = scheduledFor(saved.blocks, taskId);
  if (!landed) throw new Error("the drag did not create a block");
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["→"],
    excludes: ["not on calendar"],
    proposals: [{ id: budget.id, status: "approved" }],
    blocks: [{ taskTitle: "Budget sheet", starts_at: landed.starts_at, ends_at: landed.ends_at }],
  });
  await expect(toast).toHaveCount(0, { timeout: 6000 });
  await expect(block(page, "Budget sheet")).toBeVisible();
  const after = await readCalendar(page);
  expect(after.proposals.find((item) => item.id === budget.id)?.status).toBe("approved");
  expect(scheduledFor(after.blocks, taskId)?.starts_at).toBe(landed.starts_at);
});

test("a single Approve toast has no Undo", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const closet = proposalNamed(before, "Fix closet door");
  await press(block(page, "Fix closet door"), testInfo.project.name);
  await press(page.getByRole("button", { name: "Approve", exact: true }), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toContainText("Approved");
  expect(await toast.getByRole("button", { name: "Undo" }).count()).toBe(0);
  expect(await toast.getByRole("button", { name: "Retry" }).count()).toBe(0);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: ["Approved Fix closet door"],
    excludes: ["not on calendar"],
    proposals: [{ id: closet.id, status: "approved" }],
    blocks: [{ taskTitle: "Fix closet door", starts_at: closet.payload.starts_at || "", ends_at: closet.payload.ends_at || "" }],
  });
});

test("an Approve all toast has no Undo", async ({ page }, testInfo) => {
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  const closet = proposalNamed(before, "Fix closet door");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Call vendor", 60);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toContainText("Approved");
  expect(await toast.getByRole("button", { name: "Undo" }).count()).toBe(0);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast,
    includes: [/Approved/],
    excludes: ["not on calendar"],
    proposals: [
      { id: budget.id, status: "approved" },
      { id: closet.id, status: "approved" },
    ],
  });
});

test("revert toast fits on one line with the status visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone widths own the fit check");
  const before = await readCalendar(page);
  const budget = proposalNamed(before, "Budget sheet");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Budget sheet", 60);
  await armWriteFailure(page, [], 1);
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await expect(page.locator("[data-testid=plan-toast]")).toHaveCount(0, { timeout: 6000 });
  await press(page.getByRole("button", { name: "Revert", exact: true }), testInfo.project.name);
  await press(page.getByRole("button", { name: "Revert all" }), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "forced-failure",
    toast: page.getByTestId("plan-toast"),
    includes: ["Reverted ·", "not on calendar"],
    excludes: ["stayed approved"],
    proposals: [{ id: budget.id, status: "approved" }],
  });
  await expect(page.locator("[data-testid=plan-toast] .toast-icon")).toHaveAttribute("data-icon", "info");
  await statusFits(page, /not on calendar/);
});

test("approve-after-conflict toast fits on one line with changed visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone widths own the fit check");
  const before = await readCalendar(page);
  const spec = before.blocks.find((item) => item.title === "Spec review");
  const budget = proposalNamed(before, "Budget sheet");
  const closet = proposalNamed(before, "Fix closet door");
  if (!spec) throw new Error("spec missing");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Spec review", 60);
  const shifted = new Date(Date.parse(spec.starts_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const shiftedEnd = new Date(Date.parse(spec.ends_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
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
      block_id: spec.id,
      expected_version: spec.version,
      starts_at: shifted,
      ends_at: shiftedEnd,
      idempotency_key: "fit-newer-spec",
      title: "Spec review",
    }],
    approvals: [],
  });
  expect(changed.ok, changed.text).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("plan-banner")).toBeVisible();
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await expect(page.getByTestId("changed-tag")).toContainText("Spec review");
  await press(page.getByTestId("approve-all"), testInfo.project.name);
  await checkSaveClaim(page, {
    case: "matches-server",
    toast: page.getByTestId("plan-toast"),
    includes: ["Approved 2 ·", "changed"],
    excludes: ["proposals"],
    proposals: [
      { id: budget.id, status: "approved" },
      { id: closet.id, status: "approved" },
    ],
    blocks: [{ id: spec.id, starts_at: shifted, ends_at: shiftedEnd }],
  });
  await expect(page.locator("[data-testid=plan-toast] .toast-icon")).toHaveAttribute("data-icon", "info");
  await statusFits(page, /changed/);
});

test("compact conflict line fits and Review carries the name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone widths own the fit check");
  const before = await readCalendar(page);
  const spec = before.blocks.find((item) => item.title === "Spec review");
  if (!spec) throw new Error("spec missing");
  await press(page.getByRole("button", { name: "Plan mode" }), testInfo.project.name);
  await dragTitle(page, testInfo.project.name, "Spec review", 60);
  const shifted = new Date(Date.parse(spec.starts_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const shiftedEnd = new Date(Date.parse(spec.ends_at) + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
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
      block_id: spec.id,
      expected_version: spec.version,
      starts_at: shifted,
      ends_at: shiftedEnd,
      idempotency_key: "n3-newer-spec",
      title: "Spec review",
    }],
    approvals: [],
  });
  expect(changed.ok, changed.text).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("plan-conflict")).toBeVisible();
  const narrow = testInfo.project.name === "s23";
  const conflict = page.getByTestId("plan-conflict");
  await expect(conflict).toHaveText(narrow ? "1 changed" : /Changed · Spec review/);
  const fit = await conflict.evaluate((el) => {
    const node = el as HTMLElement;
    return { sw: node.scrollWidth, cw: node.clientWidth, text: node.textContent || "" };
  });
  expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1);
  expect(fit.text.toLowerCase()).toContain("changed");
  await press(page.getByRole("button", { name: "Review", exact: true }), testInfo.project.name);
  await expect(page.getByTestId("changed-tag")).toContainText("Spec review");
});

async function doubleTapApprove(page: Page, project: string, gap: number) {
  let commits = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/decisions/plan/commit")) commits += 1;
  });
  await press(page.getByRole("button", { name: "Plan mode" }), project);
  await dragTitle(page, project, "Call vendor", 60);
  await press(page.getByRole("button", { name: "Review", exact: true }), project);
  await page.evaluate(() => {
    const store = window as unknown as { __ghost?: number };
    store.__ghost = 0;
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".block")) store.__ghost = (store.__ghost || 0) + 1;
    });
  });
  const approve = page.getByTestId("approve-all");
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox();
  if (!box) throw new Error("approve missing");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await page.evaluate(({ px, py }) => {
    const el = document.elementFromPoint(px, py);
    return Boolean(el && el.closest("[data-testid='approve-all']"));
  }, { px: x, py: y });
  expect(hit, "the tap lands on Approve all").toBe(true);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(gap);
  await page.touchscreen.tap(x, y);
  const toast = page.getByTestId("plan-toast");
  await expect(toast).toBeVisible();
  expect(commits).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __ghost?: number }).__ghost || 0)).toBe(0);
  await expect(page.getByRole("dialog", { name: /Call vendor|Spec review|Lunch/ })).toHaveCount(0);
}

test("Approve all touch double-tap 100ms commits once without a ghost click", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "desktop has no touch screen");
  await doubleTapApprove(page, testInfo.project.name, 100);
});

test("Approve all touch double-tap 800ms commits once without a ghost click", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "desktop has no touch screen");
  await doubleTapApprove(page, testInfo.project.name, 800);
});
