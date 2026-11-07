import { describe, expect, it } from "vitest";
import type { CalendarBlock, Proposal, Task } from "../types";
import { PlanLayout } from "./layout";

function block(id: string, start: string, end: string, taskId: string | null = null): CalendarBlock {
  return {
    id,
    task_id: taskId,
    title: id,
    description: "",
    starts_at: start,
    ends_at: end,
    domain: "personal",
    invite_work_email: false,
    fixed: false,
    status: "scheduled",
    sync_state: "simulated",
    written_mode: "demo",
    honest_label: "Simulated",
    google_event_id: null,
    version: 1,
  };
}

describe("plan layout", () => {
  it("packs overlapping blocks side by side and leaves neighbors in their own lane", () => {
    const packed = PlanLayout.pack([
      { key: "a", start: 0, end: 60 },
      { key: "b", start: 30, end: 90 },
      { key: "c", start: 80, end: 120 },
      { key: "d", start: 200, end: 230 },
    ]);
    const byKey = new Map(packed.map((item) => [item.key, item]));
    expect(byKey.get("a")).toMatchObject({ lane: 0, lanes: 2 });
    expect(byKey.get("b")).toMatchObject({ lane: 1, lanes: 2 });
    expect(byKey.get("c")).toMatchObject({ lane: 0, lanes: 2 });
    expect(byKey.get("d")).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("joins an agent move from the old block to the proposed position", () => {
    const existing = block("evt_oldblock", "2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z", "task_1");
    const proposal: Proposal = {
      id: "prp_move",
      source: "sample-agent",
      source_kind: "agent",
      kind: "calendar_update",
      status: "pending",
      explanation: "Shift it later.",
      payload: {
        event_key: "evt_oldblock",
        starts_at: "2026-11-10T19:00:00Z",
        ends_at: "2026-11-10T20:00:00Z",
        title: "Call Grandma Rosa",
        domain: "personal",
        task_id: "task_1",
      },
      edited_payload: null,
      availability: null,
      version: 1,
    };
    const task = { id: "task_1", title: "Call Grandma Rosa", status: "todo" } as Task;
    const placed = PlanLayout.place({
      dayKeys: ["2026-11-10"],
      timeZone: "America/Indianapolis",
      blocks: [existing],
      proposals: [proposal],
      tasks: [task],
      find: "",
    });
    const items = placed.byDay.get("2026-11-10") ?? [];
    expect(items.find((item) => item.blockId === "evt_oldblock")?.ghost).toBe(true);
    expect(items.some((item) => item.proposalId === "prp_move" && item.kind === "proposed")).toBe(true);
    expect(placed.links).toHaveLength(1);
    expect(placed.links[0].id).toBe("prp_move");
  });
});
