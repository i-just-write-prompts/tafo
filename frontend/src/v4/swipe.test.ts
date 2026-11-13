import { describe, expect, it } from "vitest";

import { HOLD_MS } from "../v3/gesture";
import {
  EDGE_EXCLUSION_PT,
  SWIPE_COMMIT_RATIO,
  classifyMove,
  isEdgeExcluded,
  panDown,
  panMove,
  swipeShouldCommit,
} from "./swipe";

const WIDTH = 390;

describe("swipe arbitration", () => {
  it("excludes touches within 20pt of the screen edge", () => {
    expect(isEdgeExcluded(EDGE_EXCLUSION_PT, WIDTH)).toBe(true);
    expect(isEdgeExcluded(WIDTH - EDGE_EXCLUSION_PT, WIDTH)).toBe(true);
    expect(isEdgeExcluded(100, WIDTH)).toBe(false);
    const edge = panDown(1, { x: 5, y: 100 }, WIDTH, 0);
    expect(edge.kind).toBe("edge-excluded");
  });

  it("classifies shallow angles as swipe and steep angles as scroll", () => {
    expect(classifyMove(40, 10)).toBe("horizontal");
    expect(classifyMove(10, 40)).toBe("vertical");
    expect(classifyMove(5, 5)).toBe("none");
  });

  it("locks to swipe before hold, hold-drag after 300 ms, and never flips", () => {
    const down = panDown(1, { x: 50, y: 100 }, WIDTH, 0);
    const swiped = panMove(down, { x: 90, y: 105 }, 50);
    expect(swiped.kind).toBe("swipe");
    const held = panMove(down, { x: 52, y: 102 }, HOLD_MS);
    expect(held.kind).toBe("hold-drag");
    const after = panMove(swiped, { x: 200, y: 400 }, HOLD_MS + 100);
    expect(after.kind).toBe("swipe");
  });

  it("commits past 30% width", () => {
    expect(swipeShouldCommit(WIDTH * SWIPE_COMMIT_RATIO, WIDTH)).toBe(true);
    expect(swipeShouldCommit(WIDTH * 0.2, WIDTH)).toBe(false);
    expect(swipeShouldCommit(40, WIDTH, 1)).toBe(true);
  });
});
