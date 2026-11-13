import { describe, expect, it } from "vitest";

import {
  CROSS_DAY_DWELL_MS,
  crossDayHoverCell,
  crossDayIdle,
  crossDayLift,
  crossDayRelease,
  crossDayStripEnter,
  crossDayTick,
  dwellProgress,
} from "./crossDay";

describe("crossDay", () => {
  it("starts idle and lifts onto the origin day", () => {
    expect(crossDayIdle().phase).toBe("idle");
    const lift = crossDayLift("ev1", "2026-11-10", 8 * 60 + 30);
    expect(lift.phase).toBe("carrying");
    expect(lift.viewDayKey).toBe("2026-11-10");
    expect(lift.peeked).toBe(false);
  });

  it("peek opens the target day after 450 ms dwell on the strip", () => {
    let state = crossDayLift("ev1", "2026-11-10", 510);
    state = crossDayStripEnter(state);
    state = crossDayHoverCell(state, "2026-11-12");
    state = crossDayTick(state, CROSS_DAY_DWELL_MS - 1);
    expect(state.peeked).toBe(false);
    expect(dwellProgress(state)).toBeCloseTo(0.998, 2);
    state = crossDayTick(state, 5);
    expect(state.peeked).toBe(true);
    expect(state.viewDayKey).toBe("2026-11-12");
    expect(dwellProgress(state)).toBe(1);
  });

  it("cancels on strip release and saves on target grid release", () => {
    let state = crossDayLift("ev1", "2026-11-10", 510);
    state = crossDayStripEnter(state);
    state = crossDayHoverCell(state, "2026-11-12");
    const cancel = crossDayRelease(state, "strip");
    expect(cancel.effect.outcome).toBe("cancel");
    expect(cancel.state.phase).toBe("idle");

    state = crossDayLift("ev1", "2026-11-10", 510);
    state = crossDayStripEnter(state);
    state = crossDayHoverCell(state, "2026-11-12");
    state = crossDayTick(state, CROSS_DAY_DWELL_MS);
    const save = crossDayRelease(state, "grid", 14 * 60);
    expect(save.effect.outcome).toBe("cross-day-save");
    expect(save.state.phase).toBe("idle");
  });

  it("does not peek when dwelling on the origin cell while already home", () => {
    let state = crossDayLift("ev1", "2026-11-10", 510);
    state = crossDayStripEnter(state);
    state = crossDayHoverCell(state, "2026-11-10");
    state = crossDayTick(state, CROSS_DAY_DWELL_MS);
    expect(state.peeked).toBe(false);
    expect(state.viewDayKey).toBe("2026-11-10");
  });
});
