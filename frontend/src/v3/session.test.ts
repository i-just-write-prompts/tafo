import { describe, expect, it, vi } from "vitest";

import { approveDisabled, conflictingMoveIds, enterPlan, exitPlan, includedIds, loadPlan, pendingProposalIds, proposalsOnDays, revertMoves, savePlan, splitPlanSave, stageMove, toggleSkip, type StagedMove } from "./session";

function move(partial: Pick<StagedMove, "id" | "kind" | "from" | "to" | "fromDayKey" | "dayKey"> & Partial<StagedMove>): StagedMove {
  return { title: partial.id, version: 1, key: `key-${partial.id}`, ...partial };
}

describe("plan session", () => {
  it("starts empty and entering does not invent moves", () => {
    const entered = enterPlan();
    expect(entered.active).toBe(true);
    expect(entered.moves).toEqual([]);
    expect(exitPlan().active).toBe(false);
  });

  it("replaces a move for the same block and drops a no-op", () => {
    let session = enterPlan();
    session = stageMove(session, move({
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-11",
      version: 4,
    }));
    session = stageMove(session, move({
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "e", end: "f" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-12",
      version: 9,
    }));
    expect(session.moves).toHaveLength(1);
    expect(session.moves[0].dayKey).toBe("2026-11-12");
    expect(session.moves[0].version).toBe(4);
    session = stageMove(session, move({
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "a", end: "b" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-10",
    }));
    expect(session.moves).toHaveLength(0);
  });

  it("skips a proposal without counting it, and revert clears only moves", () => {
    let session = enterPlan();
    session = stageMove(session, move({
      id: "gym",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-09",
      dayKey: "2026-11-09",
    }));
    session = toggleSkip(session, "closet");
    expect(includedIds(["budget", "closet"], session.skipped)).toEqual(["budget"]);
    expect(approveDisabled(1, 1)).toBe(false);
    session = toggleSkip(session, "budget");
    expect(includedIds(["budget", "closet"], session.skipped)).toEqual([]);
    expect(approveDisabled(0, 0)).toBe(true);
    session = revertMoves(session);
    expect(session.moves).toEqual([]);
    expect(session.active).toBe(true);
    expect(session.skipped).toEqual(["closet", "budget"]);
  });

  it("includes every pending proposal in the visible range", () => {
    const events = [
      { id: "budget", dayKey: "2026-11-10", state: "proposed" },
      { id: "closet", dayKey: "2026-11-10", state: "proposed" },
      { id: "other", dayKey: "2026-11-16", state: "proposed" },
      { id: "spec", dayKey: "2026-11-10", state: "approved" },
    ];
    const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
    expect(proposalsOnDays(events, week).map((event) => event.id)).toEqual(["budget", "closet"]);
    expect(proposalsOnDays(events, ["2026-11-10"]).map((event) => event.id)).toEqual(["budget", "closet"]);
  });

  it("treats a moved proposal as a decision and remembers it for reload", () => {
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    });
    expect(pendingProposalIds(["budget", "closet"], [{ id: "budget" }])).toEqual(["closet"]);
    memory.set("tafo.v3.plan", JSON.stringify({ active: true, moves: [{ id: "old" }], skipped: [] }));
    const session = stageMove(enterPlan(), move({
      id: "budget",
      kind: "proposal",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-10",
      version: 2,
    }));
    savePlan(session);
    expect(loadPlan().moves.map((item) => item.id)).toEqual(["budget"]);
    expect(memory.has("tafo.v3.plan")).toBe(false);
    savePlan(exitPlan());
    expect(loadPlan().active).toBe(false);
    expect(loadPlan().moves).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("counts only the moves and proposals the server read shows", () => {
    const moves = [
      { id: "spec", kind: "block" as const, to: { start: "2026-11-11T14:30:00Z", end: "2026-11-11T16:00:00Z" } },
      { id: "budget", kind: "proposal" as const, to: { start: "2026-11-10T20:15:00Z", end: "2026-11-10T21:45:00Z" } },
    ];
    const saved = splitPlanSave(
      moves,
      ["closet"],
      [{ id: "spec", starts_at: "2026-11-10T14:30:00.000Z", ends_at: "2026-11-10T16:00:00Z" }],
      [
        { id: "budget", status: "pending", starts_at: "2026-11-10T19:00:00Z", ends_at: "2026-11-10T20:30:00Z" },
        { id: "closet", status: "pending" },
      ],
    );
    expect(saved.savedMoveIds).toEqual([]);
    expect(saved.unsavedMoveIds).toEqual(["spec", "budget"]);
    expect(saved.savedProposalIds).toEqual([]);
    const kept = splitPlanSave(
      moves,
      ["closet"],
      [{ id: "spec", starts_at: "2026-11-11T14:30:00Z", ends_at: "2026-11-11T16:00:00Z" }],
      [
        { id: "budget", status: "approved", starts_at: "2026-11-10T20:15:00Z", ends_at: "2026-11-10T21:45:00Z" },
        { id: "closet", status: "approved" },
      ],
    );
    expect(kept.savedMoveIds).toEqual(["spec", "budget"]);
    expect(kept.savedProposalIds).toEqual(["closet"]);
    expect(conflictingMoveIds(
      [{ id: "spec", kind: "block", version: 1, from: { start: "2026-11-10T14:30:00Z", end: "2026-11-10T16:00:00Z" } }],
      [{ id: "spec", version: 2, starts_at: "2026-11-10T14:30:00Z", ends_at: "2026-11-10T16:00:00Z" }],
      [],
    )).toEqual(["spec"]);
  });
});
