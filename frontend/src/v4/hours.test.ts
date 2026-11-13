import { describe, expect, it } from "vitest";
import { headsUpForMove, inCategoryHours, sacredOverlap } from "./hours";
import type { HoursPayload } from "./hoursTypes";

const sample: HoursPayload = {
  summary: "Work 9–5 · 2 sacred windows",
  category_hours: [
    { domain: "work", weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60 },
    { domain: "home", weekday: 1, start_minutes: 17 * 60, end_minutes: 22 * 60 },
  ],
  sacred_windows: [
    {
      id: "dinner",
      name: "Family dinner",
      days_mask: 127,
      start_minutes: 18 * 60,
      end_minutes: 19 * 60 + 30,
      agent_block: 1,
      heads_up: 1,
      version: 1,
    },
  ],
};

describe("slice2 hours", () => {
  it("detects work item in home hours", () => {
    const tag = headsUpForMove(sample, "work", 1, 20, 21);
    expect(tag?.label).toBe("Home hours");
    expect(tag?.trayLine).toBe("In your home hours");
  });

  it("detects sacred overlap", () => {
    const sacred = sacredOverlap(sample.sacred_windows, 1, 18 * 60 + 15, 19 * 60);
    expect(sacred?.name).toBe("Family dinner");
  });

  it("respects category spans", () => {
    expect(inCategoryHours(sample.category_hours, "work", 1, 10 * 60, 11 * 60)).toBe(true);
    expect(inCategoryHours(sample.category_hours, "work", 1, 20 * 60, 21 * 60)).toBe(false);
  });
});
