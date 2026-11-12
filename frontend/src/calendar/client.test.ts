import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import type { CalendarBlock, Proposal } from "../types";
import { ENTIRE_CALENDAR, createCalendarClient, type CalendarTransport, type PlanMoveInput } from "./client";

function block(overrides: Partial<CalendarBlock> = {}): CalendarBlock {
  return {
    id: "blk_spec",
    task_id: "task_spec",
    title: "Spec review",
    description: "",
    starts_at: "2026-11-10T15:00:00Z",
    ends_at: "2026-11-10T16:00:00Z",
    domain: "work",
    invite_work_email: false,
    fixed: false,
    status: "scheduled",
    sync_state: "simulated",
    written_mode: "demo",
    honest_label: "Demo",
    google_event_id: null,
    version: 4,
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prp_budget",
    source: "plan",
    source_kind: "human",
    kind: "calendar_block",
    status: "pending",
    explanation: "Suggested.",
    payload: { title: "Budget sheet", starts_at: "2026-11-10T17:00:00Z", ends_at: "2026-11-10T18:00:00Z" },
    edited_payload: null,
    availability: null,
    version: 2,
    ...overrides,
  };
}

function callsOf(transport: CalendarTransport & { calls: Array<{ path: string; body: unknown }> }) {
  return transport.calls;
}

function recording(handler: (path: string, body: unknown, call: number) => unknown): CalendarTransport & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async request(path, init) {
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      calls.push({ path, body });
      return handler(path, body, calls.length);
    },
  };
}

const planMove: PlanMoveInput = {
  blockId: "blk_spec",
  expectedVersion: 4,
  startsAt: "2026-11-11T15:00:00Z",
  endsAt: "2026-11-11T16:00:00Z",
  idempotencyKey: "plan.same-key",
  title: "Spec review",
  acknowledgeFixedMove: false,
};

describe("CalendarClient", () => {
  it("loads the blocks and proposals that overlap the range", async () => {
    const inside = block();
    const outside = block({
      id: "blk_later",
      starts_at: "2026-11-12T15:00:00Z",
      ends_at: "2026-11-12T16:00:00Z",
    });
    const pending = proposal();
    const elsewhere = proposal({
      id: "prp_later",
      payload: { starts_at: "2026-11-12T15:00:00Z", ends_at: "2026-11-12T16:00:00Z" },
    });
    const timeless = proposal({ id: "prp_note", kind: "task_change", payload: { title: "Note" } });
    const transport = recording((path) => {
      if (path === "/api/calendar/blocks") return { blocks: [inside, outside] };
      if (path === "/api/hermes/proposals") return { proposals: [pending, elsewhere, timeless] };
      throw new Error(path);
    });
    const client = createCalendarClient({ transport });
    const day = await client.load({ start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" });
    expect(day.blocks.map((item) => item.id)).toEqual(["blk_spec"]);
    expect(day.proposals.map((item) => item.id)).toEqual(["prp_budget", "prp_note"]);
    const all = await client.load(ENTIRE_CALENDAR);
    expect(all.blocks.map((item) => item.id)).toEqual(["blk_spec", "blk_later"]);
    expect(all.proposals.map((item) => item.id)).toEqual(["prp_budget", "prp_later", "prp_note"]);
  });

  it("moves a block by proposing it and then approving it", async () => {
    const transport = recording((path, body) => {
      if (path === "/api/hermes/proposals") {
        const sent = body as { idempotency_key: string };
        return proposal({ id: "prp_move", version: 1, payload: { idempotency_key: sent.idempotency_key } });
      }
      if (path === "/api/decisions/prp_move/approve") {
        return {
          proposal: proposal({ id: "prp_move", version: 2, status: "approved" }),
          outbox: { status: "simulated" },
          block: block({ version: 5, starts_at: "2026-11-10T18:00:00Z" }),
          idempotent_replay: false,
        };
      }
      throw new Error(path);
    });
    const client = createCalendarClient({ transport });
    const saved = await client.move({
      kind: "block",
      title: "Spec review",
      startsAt: "2026-11-10T18:00:00Z",
      endsAt: "2026-11-10T19:00:00Z",
      timeZone: "America/Indianapolis",
      block: block(),
    });
    const [propose, approve] = callsOf(transport);
    expect(propose?.path).toBe("/api/hermes/proposals");
    expect(propose?.body).toMatchObject({
      source: "plan",
      source_kind: "human",
      kind: "calendar_update",
      explanation: "Moved Spec review.",
      payload: {
        event_key: "blk_spec",
        task_id: "task_spec",
        starts_at: "2026-11-10T18:00:00Z",
        ends_at: "2026-11-10T19:00:00Z",
        timezone: "America/Indianapolis",
        title: "Spec review",
      },
    });
    const proposed = propose?.body as { idempotency_key: string; payload: { expected_version?: number } };
    expect(proposed.idempotency_key).toMatch(/^move\.[A-Za-z0-9_.:-]{6,}$/);
    expect(proposed.payload.expected_version).toBeUndefined();
    expect(approve?.path).toBe("/api/decisions/prp_move/approve");
    expect(approve?.body).toEqual({ expected_version: 1, confirmed: true, acknowledge_fixed_move: false });
    expect(saved.outcome).toBe("saved");
    expect(saved.block?.version).toBe(5);
    expect(saved.idempotentReplay).toBe(false);
  });

  it("moves a pending proposal by editing it, approving it, and undoes at the next version", async () => {
    const transport = recording((path) => {
      if (path === "/api/decisions/prp_budget/edit") return proposal({ version: 3 });
      if (path === "/api/decisions/prp_budget/approve") {
        return { proposal: proposal({ version: 4, status: "approved" }), outbox: { status: "simulated" }, block: null, idempotent_replay: false };
      }
      throw new Error(path);
    });
    const client = createCalendarClient({ transport });
    const original = proposal();
    await client.move({
      kind: "proposal",
      title: "Budget sheet",
      startsAt: "2026-11-10T19:00:00Z",
      endsAt: "2026-11-10T20:00:00Z",
      timeZone: "America/Indianapolis",
      proposal: original,
    });
    await client.undo({
      kind: "proposal",
      title: "Budget sheet",
      startsAt: "2026-11-10T17:00:00Z",
      endsAt: "2026-11-10T18:00:00Z",
      timeZone: "America/Indianapolis",
      proposal: original,
    });
    const [moved, approved, undone] = callsOf(transport);
    expect(moved?.body).toMatchObject({
      expected_version: 2,
      confirmed: true,
      payload: { starts_at: "2026-11-10T19:00:00Z", ends_at: "2026-11-10T20:00:00Z", title: "Budget sheet" },
    });
    expect(approved?.path).toBe("/api/decisions/prp_budget/approve");
    expect(undone?.body).toMatchObject({
      expected_version: 3,
      confirmed: true,
      payload: { starts_at: "2026-11-10T17:00:00Z", ends_at: "2026-11-10T18:00:00Z" },
    });
  });

  it("returns a 409 version conflict from move and from commitPlan", async () => {
    const transport = recording((path) => {
      if (path === "/api/hermes/proposals") return proposal({ id: "prp_move", version: 1 });
      throw new ApiError("Spec review changed, so nothing was saved.", { status: 409, code: "version_conflict" });
    });
    const client = createCalendarClient({ transport, sleep: async () => undefined });
    await expect(client.move({
      kind: "block",
      title: "Spec review",
      startsAt: "2026-11-10T18:00:00Z",
      endsAt: "2026-11-10T19:00:00Z",
      timeZone: "America/Indianapolis",
      block: block(),
    })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    await expect(client.commitPlan({ moves: [planMove], approvals: [] })).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
    });
    expect(callsOf(transport).some((call) => call.path === "/api/calendar/blocks")).toBe(false);
  });

  it("reports not_synced when the calendar write does not land", async () => {
    const transport = recording((path) => {
      if (path === "/api/hermes/proposals") return proposal({ id: "prp_move", version: 1 });
      if (path === "/api/decisions/prp_move/approve") {
        return {
          proposal: proposal({ id: "prp_move", status: "approved" }),
          outbox: { status: "failed" },
          block: block({ sync_state: "not_synced" }),
          idempotent_replay: false,
        };
      }
      if (path === "/api/decisions/plan/commit") {
        return {
          moves: [{ saved: false, outcome: "not_synced", item_id: "blk_spec", item_title: "Spec review", idempotent_replay: false }],
          approvals: [],
        };
      }
      if (path === "/api/calendar/blocks") return { blocks: [] };
      if (path === "/api/hermes/proposals") return { proposals: [] };
      throw new Error(path);
    });
    const client = createCalendarClient({ transport, sleep: async () => undefined });
    const moved = await client.move({
      kind: "block",
      title: "Spec review",
      startsAt: "2026-11-10T18:00:00Z",
      endsAt: "2026-11-10T19:00:00Z",
      timeZone: "America/Indianapolis",
      block: block(),
    });
    expect(moved.outcome).toBe("not_synced");
    expect(moved.block?.sync_state).toBe("not_synced");
    const committed = await client.commitPlan({ moves: [planMove], approvals: [] });
    expect(committed.moves[0]).toMatchObject({ id: "blk_spec", saved: false, outcome: "not_synced" });
    expect(committed.confirmed).toBe(true);
  });

  it("retries a failed confirmation read and stays unconfirmed", async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const transport = recording((path) => {
      if (path === "/api/decisions/plan/commit") {
        return {
          moves: [{ saved: true, outcome: "saved", item_id: "blk_spec", item_title: "Spec review", idempotent_replay: false }],
          approvals: [],
        };
      }
      reads += 1;
      throw new ApiError("down", { status: 500 });
    });
    const client = createCalendarClient({
      transport,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await client.commitPlan({ moves: [planMove], approvals: [] });
    expect(result.confirmed).toBe(false);
    expect(result.moves[0]?.saved).toBe(true);
    expect(sleeps).toEqual([200, 500]);
    expect(reads).toBe(6);
  });

  it("confirms on a later read after earlier confirmation reads fail", async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const transport = recording((path) => {
      if (path === "/api/decisions/plan/commit") {
        return { moves: [{ saved: true, outcome: "saved", item_id: "blk_spec", item_title: "Spec review" }], approvals: [] };
      }
      reads += 1;
      if (reads <= 4) throw new ApiError("down", { status: 500 });
      return path === "/api/calendar/blocks" ? { blocks: [block()] } : { proposals: [] };
    });
    const client = createCalendarClient({
      transport,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await client.commitPlan({ moves: [planMove], approvals: [] });
    expect(result.confirmed).toBe(true);
    expect(sleeps).toEqual([200, 500]);
    expect(reads).toBe(6);
  });

  it("sends the same idempotency key again and reports the replay", async () => {
    let commits = 0;
    const transport = recording((path) => {
      if (path === "/api/decisions/plan/commit") {
        commits += 1;
        return {
          moves: [{
            saved: true,
            outcome: "saved",
            item_id: "blk_spec",
            item_title: "Spec review",
            idempotent_replay: commits > 1,
          }],
          approvals: [],
        };
      }
      if (path === "/api/calendar/blocks") return { blocks: [block()] };
      return { proposals: [] };
    });
    const client = createCalendarClient({ transport, sleep: async () => undefined });
    const first = await client.commitPlan({ moves: [planMove], approvals: [] });
    const second = await client.commitPlan({ moves: [planMove], approvals: [] });
    const keys = callsOf(transport)
      .filter((call) => call.path === "/api/decisions/plan/commit")
      .map((call) => (call.body as { moves: Array<{ idempotency_key: string }> }).moves[0]?.idempotency_key);
    expect(keys).toEqual(["plan.same-key", "plan.same-key"]);
    expect(first.moves[0]?.idempotentReplay).toBe(false);
    expect(second.moves[0]?.idempotentReplay).toBe(true);
    expect(client.saveKey("plan", "plan.same-key", true)).toBe("plan.same-key");
    expect(client.saveKey("plan", "plan.same-key", false)).toMatch(/^plan\./);
  });

  it("returns a suggestion that does not overlap notThese and drops one that does", async () => {
    const transport = recording(() => ({
      starts_at: "2026-11-10T15:00:00Z",
      ends_at: "2026-11-10T16:00:00Z",
      starts_local: "2026-11-10T10:00:00",
      ends_local: "2026-11-10T11:00:00",
      avoided_known_conflicts: true,
      outlook_gap: "Outlook is not connected.",
    }));
    const client = createCalendarClient({ transport });
    const open = await client.suggest(
      { taskId: "task_spec", durationMinutes: 60 },
      { notThese: [{ start: "2026-11-10T18:00:00Z", end: "2026-11-10T19:00:00Z" }] },
    );
    const blocked = await client.suggest(
      { durationMinutes: 30 },
      { notThese: [{ start: "2026-11-10T15:30:00Z", end: "2026-11-10T15:45:00Z" }] },
    );
    expect(open).toEqual({
      status: "open",
      slot: {
        startsAt: "2026-11-10T15:00:00Z",
        endsAt: "2026-11-10T16:00:00Z",
        startsLocal: "2026-11-10T10:00:00",
        endsLocal: "2026-11-10T11:00:00",
        avoidedKnownConflicts: true,
        outlookGap: "Outlook is not connected.",
      },
    });
    expect(blocked).toEqual({ status: "blocked", reason: "not_these" });
    expect(callsOf(transport).map((call) => call.path)).toEqual([
      "/api/calendar/suggestion?task_id=task_spec&duration_minutes=60",
      "/api/calendar/suggestion?duration_minutes=30",
    ]);
  });
});
