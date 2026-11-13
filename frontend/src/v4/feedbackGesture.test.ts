import { describe, expect, it } from "vitest";
import { HOLD_MS } from "../v3/gesture";
import { FEEDBACK_HOLD_MS } from "./feedbackGesture";

describe("gesture arbitration invariants", () => {
  it("block lift still arms at 300 ms", () => {
    expect(HOLD_MS).toBe(300);
  });

  it("feedback hold stays at 600 ms", () => {
    expect(FEEDBACK_HOLD_MS).toBe(600);
  });
});
