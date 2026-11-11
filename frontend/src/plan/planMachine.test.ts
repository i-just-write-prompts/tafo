import { describe, expect, it } from "vitest";
import type { DragState } from "./store";
import { PlanMachine } from "./planMachine";

function drag(overrides: Partial<DragState> = {}): DragState {
  return {
    kind: "schedule",
    pointerId: 1,
    originX: 0,
    originY: 0,
    x: 0,
    y: 0,
    moved: false,
    key: "plan.block.same",
    taskId: "task_1",
    durationMin: 90,
    grabMin: 0,
    ...overrides,
  };
}

describe("plan interaction machine", () => {
  it("treats a second drop of the same gesture as one commit", () => {
    let state = PlanMachine.initial();
    state = PlanMachine.reduce(state, { type: "begin", drag: drag() }).state;
    state = PlanMachine.reduce(state, { type: "move", pointerId: 1, x: 40, y: 12 }).state;
    const first = PlanMachine.reduce(state, { type: "up", pointerId: 1 });
    expect(first.commit?.key).toBe("plan.block.same");
    const second = PlanMachine.reduce(first.state, { type: "up", pointerId: 1 });
    expect(second.commit).toBeNull();
    const again = PlanMachine.reduce(first.state, { type: "begin", drag: drag({ x: 80, y: 80 }) });
    const moved = PlanMachine.reduce(again.state, { type: "move", pointerId: 1, x: 120, y: 90 });
    const replay = PlanMachine.reduce(moved.state, { type: "up", pointerId: 1 });
    expect(replay.commit).toBeNull();
    expect(replay.state.drag).toBeNull();
  });

  it("rolls back an optimistic move after a 409", () => {
    let state = PlanMachine.initial();
    state = PlanMachine.reduce(state, {
      type: "override",
      blockId: "evt_1",
      span: { starts_at: "2026-11-04T19:00:00Z", ends_at: "2026-11-04T20:00:00Z" },
    }).state;
    expect(state.overrides.evt_1?.starts_at).toBe("2026-11-04T19:00:00Z");
    state = PlanMachine.reduce(state, { type: "rollback", blockId: "evt_1" }).state;
    expect(state.overrides.evt_1).toBeUndefined();
  });

  it("cancels a drag on escape without committing", () => {
    let state = PlanMachine.initial();
    state = PlanMachine.reduce(state, { type: "begin", drag: drag() }).state;
    state = PlanMachine.reduce(state, { type: "move", pointerId: 1, x: 30, y: 8 }).state;
    const cancelled = PlanMachine.reduce(state, { type: "escape" });
    expect(cancelled.commit).toBeNull();
    expect(cancelled.state.drag).toBeNull();
    expect(cancelled.state.usedKeys).toEqual([]);
  });

  it("moves a focused block by 15 minutes or one day", () => {
    const zone = "America/Indianapolis";
    const earlier = PlanMachine.nudge("2026-11-04T14:00:00Z", "2026-11-04T15:30:00Z", -15, 0, zone);
    expect(earlier).toEqual({ starts_at: "2026-11-04T13:45:00Z", ends_at: "2026-11-04T15:15:00Z" });
    const nextDay = PlanMachine.nudge("2026-11-04T14:00:00Z", "2026-11-04T15:30:00Z", 0, 1, zone);
    expect(nextDay).toEqual({ starts_at: "2026-11-05T14:00:00Z", ends_at: "2026-11-05T15:30:00Z" });
  });
});
