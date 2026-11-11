import { describe, expect, it } from "vitest";

import type { CalendarBlock, Proposal, Task } from "../types";
import { buildEvents, showSummary, visibleEvents, ALL_SHOWN } from "./model";

const zone = "America/Indianapolis";

function task(partial: Partial<Task> & Pick<Task, "id" | "title" | "domain">): Task {
  return {
    status: "todo",
    estimate_hours: 1,
    due_date: null,
    notes: "",
    sort_order: 1,
    on_today: false,
    version: 1,
    subtasks: [],
    tracked_seconds: 0,
    progress: { checklist_done: 0, checklist_total: 0, estimate_hours: 1, tracked_hours: 0 },
    ...partial,
  };
}

function block(partial: Partial<CalendarBlock> & Pick<CalendarBlock, "id" | "title" | "starts_at" | "ends_at">): CalendarBlock {
  return {
    task_id: null,
    description: "",
    domain: "work",
    invite_work_email: false,
    fixed: false,
    status: "scheduled",
    sync_state: "simulated",
    written_mode: "demo",
    honest_label: "Demo",
    google_event_id: null,
    version: 1,
    ...partial,
  };
}

describe("calendar events", () => {
  it("marks a done task and a pending proposal, and hides filtered ones", () => {
    const tasks = [
      task({ id: "task-stand", title: "Standup", domain: "work", status: "done" }),
      task({ id: "task-budget", title: "Budget sheet", domain: "work" }),
    ];
    const blocks = [
      block({
        id: "blk-stand",
        task_id: "task-stand",
        title: "Standup",
        starts_at: "2026-11-10T14:00:00Z",
        ends_at: "2026-11-10T14:30:00Z",
      }),
    ];
    const proposals: Proposal[] = [
      {
        id: "prp-budget",
        source: "sample-agent",
        source_kind: "agent",
        kind: "calendar_block",
        status: "pending",
        explanation: "due Fri; longest free work stretch today.",
        payload: {
          task_id: "task-budget",
          domain: "work",
          starts_at: "2026-11-10T19:00:00Z",
          ends_at: "2026-11-10T20:30:00Z",
        },
        edited_payload: null,
        availability: null,
        version: 1,
      },
    ];
    const events = buildEvents(tasks, blocks, proposals, zone);
    expect(events.map((event) => [event.title, event.state, event.startHour])).toEqual([
      ["Standup", "done", 9],
      ["Budget sheet", "proposed", 14],
    ]);
    expect(events[1].explanation).toBe("due Fri; longest free work stretch today.");
    expect(visibleEvents(events, { ...ALL_SHOWN, proposals: false }, "").map((event) => event.title)).toEqual(["Standup"]);
    expect(visibleEvents(events, ALL_SHOWN, "budget").map((event) => event.id)).toEqual(["prp-budget"]);
    expect(showSummary(ALL_SHOWN)).toBe("All calendars · proposals on");
    expect(showSummary({ ...ALL_SHOWN, work: false, proposals: false })).toBe("Home, Personal · proposals off");
  });

  it("draws an approved proposal with a failed write and no block as Not on calendar", () => {
    const tasks = [task({ id: "task-budget", title: "Budget sheet", domain: "work" })];
    const proposals: Proposal[] = [
      {
        id: "prp-budget",
        source: "sample-agent",
        source_kind: "agent",
        kind: "calendar_block",
        status: "approved",
        explanation: "due Fri",
        payload: {
          task_id: "task-budget",
          domain: "work",
          starts_at: "2026-11-10T19:00:00Z",
          ends_at: "2026-11-10T20:30:00Z",
        },
        edited_payload: null,
        availability: null,
        version: 2,
      },
    ];
    const events = buildEvents(tasks, [], proposals, zone, [
      { id: "obx-budget", proposal_id: "prp-budget", status: "failed", operation: "create", event_key: "evt-budget" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "prp-budget",
      title: "Budget sheet",
      state: "unplaced",
      outboxId: "obx-budget",
      start: "2026-11-10T19:00:00Z",
    });
    expect(visibleEvents(events, { ...ALL_SHOWN, proposals: false }, "").map((event) => event.id)).toEqual(["prp-budget"]);
    const sharing = buildEvents(
      tasks,
      [block({ id: "evt-other", task_id: "task-budget", title: "Other session", starts_at: "2026-11-10T21:00:00Z", ends_at: "2026-11-10T22:00:00Z" })],
      proposals,
      zone,
      [{ id: "obx-budget", proposal_id: "prp-budget", status: "failed", operation: "create", event_key: "evt-budget" }],
    );
    expect(sharing.find((event) => event.id === "prp-budget")?.state).toBe("unplaced");
    expect(sharing.map((event) => event.id).sort()).toEqual(["evt-other", "prp-budget"]);
    const own = buildEvents(
      tasks,
      [block({
        id: "evt-budget",
        task_id: "task-budget",
        title: "Budget sheet",
        starts_at: "2026-11-10T19:00:00Z",
        ends_at: "2026-11-10T20:30:00Z",
        origin_proposal_id: "prp-budget",
      })],
      proposals,
      zone,
      [{ id: "obx-budget", proposal_id: "prp-budget", status: "failed", operation: "create", event_key: "evt-different" }],
    );
    expect(own.map((event) => event.state)).toEqual(["approved"]);
    const landed = buildEvents(
      tasks,
      [block({ id: "evt-budget", task_id: "task-budget", title: "Budget sheet", starts_at: "2026-11-10T19:00:00Z", ends_at: "2026-11-10T20:30:00Z" })],
      proposals,
      zone,
      [{ id: "obx-budget", proposal_id: "prp-budget", status: "simulated", operation: "create", event_key: "evt-budget" }],
    );
    expect(landed.map((event) => event.state)).toEqual(["approved"]);
  });
});
