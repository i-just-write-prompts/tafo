import { describe, expect, it, vi } from "vitest";

import { approveDisabled, enterPlan, exitPlan, includedIds, loadPlan, pendingProposalIds, proposalsOnDays, revertMoves, savePlan, stageMove, toggleSkip } from "./session";

describe("plan session", () => {
  it("starts empty and entering does not invent moves", () => {
    const entered = enterPlan();
    expect(entered.active).toBe(true);
    expect(entered.moves).toEqual([]);
    expect(exitPlan().active).toBe(false);
  });

  it("replaces a move for the same block and drops a no-op", () => {
    let session = enterPlan();
    session = stageMove(session, {
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-11",
    });
    session = stageMove(session, {
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "e", end: "f" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-12",
    });
    expect(session.moves).toHaveLength(1);
    expect(session.moves[0].dayKey).toBe("2026-11-12");
    session = stageMove(session, {
      id: "spec",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "a", end: "b" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-10",
    });
    expect(session.moves).toHaveLength(0);
  });

  it("skips a proposal without counting it, and revert clears only moves", () => {
    let session = enterPlan();
    session = stageMove(session, {
      id: "gym",
      kind: "block",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-09",
      dayKey: "2026-11-09",
    });
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
    const session = stageMove(enterPlan(), {
      id: "budget",
      kind: "proposal",
      from: { start: "a", end: "b" },
      to: { start: "c", end: "d" },
      fromDayKey: "2026-11-10",
      dayKey: "2026-11-10",
    });
    savePlan(session);
    expect(loadPlan().moves.map((move) => move.id)).toEqual(["budget"]);
    savePlan(exitPlan());
    expect(loadPlan().active).toBe(false);
    expect(loadPlan().moves).toEqual([]);
    vi.unstubAllGlobals();
  });
});
