import { expect, type Locator, type Page } from "@playwright/test";

export type CalendarBlockRow = {
  id: string;
  title: string;
  task_id?: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
};

export type ProposalRow = {
  id: string;
  status: string;
  kind: string;
  payload: { task_id?: string; starts_at?: string; ends_at?: string };
  edited_payload?: { starts_at?: string; ends_at?: string } | null;
};

export type TaskRow = { id: string; title: string };

export type BlockClaim = { id?: string; title?: string; taskTitle?: string; starts_at: string; ends_at?: string };
export type ProposalClaim = { id: string; status: string };

/** A save-claiming toast has to match a server read. Failure and retry are the same check. */
export type SaveClaim = {
  case: "matches-server" | "forced-failure" | "failure-then-retry";
  toast?: Locator;
  includes?: Array<string | RegExp>;
  excludes?: Array<string | RegExp>;
  blocks?: BlockClaim[];
  proposals?: ProposalClaim[];
  /** After a failed write, run the retry and check this claim. */
  retry?: () => Promise<void>;
  afterRetry?: Omit<SaveClaim, "case" | "retry" | "afterRetry">;
};

export async function readCalendar(page: Page) {
  const blocks = await (await page.request.get("/api/calendar/blocks")).json() as { blocks: CalendarBlockRow[] };
  const proposals = await (await page.request.get("/api/hermes/proposals")).json() as { proposals: ProposalRow[] };
  const tasks = await (await page.request.get("/api/tasks?view=all&scope=all")).json() as { tasks: TaskRow[] };
  return { blocks: blocks.blocks, proposals: proposals.proposals, tasks: tasks.tasks };
}

export function uiWhen(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Indianapolis",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("month")} ${part("day")}`;
}

export async function renderedToast(toast: Locator): Promise<string> {
  const text = await toast.locator("p").evaluate((el) => (el as HTMLElement).innerText);
  return text.replace(/\s+/g, " ").trim();
}

async function assertClaim(page: Page, claim: Omit<SaveClaim, "case" | "retry" | "afterRetry">) {
  if (claim.toast) {
    for (const text of claim.includes ?? []) await expect(claim.toast).toContainText(text);
    for (const text of claim.excludes ?? []) await expect(claim.toast).not.toContainText(text);
  }
  const state = await readCalendar(page);
  for (const want of claim.blocks ?? []) {
    const row = state.blocks.find((item) => {
      if (item.status !== "scheduled") return false;
      if (want.id) return item.id === want.id;
      if (want.taskTitle) {
        const task = state.tasks.find((entry) => entry.id === item.task_id);
        return task?.title === want.taskTitle;
      }
      return item.title === want.title;
    });
    expect(row, want.taskTitle || want.title || want.id).toBeTruthy();
    expect(Date.parse(row?.starts_at || "")).toBe(Date.parse(want.starts_at));
    if (want.ends_at) expect(Date.parse(row?.ends_at || "")).toBe(Date.parse(want.ends_at));
  }
  for (const want of claim.proposals ?? []) {
    const row = state.proposals.find((item) => item.id === want.id);
    expect(row?.status).toBe(want.status);
  }
  return state;
}

function claimedIds(claim: Omit<SaveClaim, "case" | "retry" | "afterRetry">): string[] {
  return [
    ...(claim.blocks ?? []).map((item) => item.id || ""),
    ...(claim.proposals ?? []).map((item) => item.id),
  ].filter(Boolean);
}

export async function checkSaveClaim(page: Page, claim: SaveClaim): Promise<string> {
  await assertClaim(page, claim);
  if (claim.case === "failure-then-retry") {
    if (!claim.retry || !claim.afterRetry) throw new Error("failure-then-retry needs retry and afterRetry");
    const retried = new Set(claimedIds(claim.afterRetry));
    for (const id of claimedIds(claim)) {
      if (!retried.has(id)) throw new Error(`retry did not re-check ${id}`);
    }
    await claim.retry();
    await assertClaim(page, claim.afterRetry);
  }
  return claim.toast ? renderedToast(claim.toast) : "";
}

export async function armWriteFailure(page: Page, eventKeys: string[] = [], failCreates = 0) {
  const response = await page.request.post("/api/e2e/fail-writes", {
    data: { event_keys: eventKeys, fail_creates: failCreates },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
