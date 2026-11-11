import { describe, expect, it } from "vitest";

import { gestureDown, gestureMove, gestureUp, HOLD_MS, holdReady } from "./gesture";

describe("quick drag gesture", () => {
  it("lifts only after the hold and commits on release", () => {
    const down = gestureDown(1, "t3", { x: 10, y: 20 }, 0);
    expect(holdReady(down, HOLD_MS - 1).phase).toBe("pending");
    const lifted = holdReady(down, HOLD_MS);
    expect(lifted.phase).toBe("lifted");
    const moved = gestureMove(lifted, { x: 10, y: 80 });
    expect(moved.phase).toBe("lifted");
    expect(gestureUp(moved)).toMatchObject({ commit: true, tap: false });
  });

  it("treats a short press as a tap and a slide before the hold as a scroll", () => {
    const down = gestureDown(1, "t3", { x: 0, y: 0 }, 0);
    expect(gestureUp(down)).toMatchObject({ commit: false, tap: true });
    const slid = gestureMove(down, { x: 0, y: 30 });
    expect(slid.phase).toBe("idle");
    expect(gestureUp(slid).commit).toBe(false);
  });

  it("a hold that does not move opens the block instead of saving", () => {
    const lifted = holdReady(gestureDown(4, "budget", { x: 5, y: 5 }, 0), 400);
    expect(gestureUp(gestureMove(lifted, { x: 6, y: 6 }))).toMatchObject({ commit: false, tap: true });
  });
});
