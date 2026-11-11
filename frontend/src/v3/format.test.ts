import { describe, expect, it } from "vitest";

import {
  approveLabel,
  approvedToast,
  partialPlanToast,
  bannerText,
  clock,
  compactRange,
  dayTitle,
  dragReadout,
  gutterClock,
  quickToast,
  refusedMoveToast,
  revertToast,
  unplacedToast,
  compactConflict,
  rangeLabel,
  shortRange,
  weekTitle,
} from "./format";

describe("v3 clock copy", () => {
  it("matches the frame ranges", () => {
    expect(clock(9)).toBe("9 AM");
    expect(clock(9.5)).toBe("9:30 AM");
    expect(rangeLabel(9, 9.5)).toBe("9:00–9:30 AM");
    expect(rangeLabel(9.5, 11)).toBe("9:30–11:00 AM");
    expect(rangeLabel(10, 10.5)).toBe("10:00–10:30 AM");
    expect(rangeLabel(12, 13)).toBe("12:00–1:00 PM");
    expect(rangeLabel(14, 15.5)).toBe("2:00–3:30 PM");
    expect(rangeLabel(17, 18)).toBe("5:00–6:00 PM");
    expect(rangeLabel(11, 12.5)).toBe("11:00 AM–12:30 PM");
    expect(rangeLabel(10, 12.5)).toBe("10:00 AM–12:30 PM");
    expect(shortRange(10, 10.5)).toBe("10–10:30");
    expect(gutterClock(10.75)).toBe("10:45");
    expect(gutterClock(11)).toBe("11:00");
    expect(quickToast("Call vendor", 11)).toBe("Call vendor → 11:00 AM");
    expect(refusedMoveToast("Lunch w/ Sam")).toBe("Lunch w/ Sam didn't move.");
    expect(dragReadout("Call Grandma Rosa", "Thu", 16.5, 17.5)).toBe("Call Grandma Rosa · Thu 4:30–5:30 PM");
    expect(compactRange(10.5, 11)).toBe("10:30–11 AM");
  });

  it("names the open day and the week", () => {
    expect(dayTitle("2026-11-10")).toBe("Tue, Nov 10");
    expect(weekTitle("2026-11-09")).toBe("Nov 9–15");
    expect(weekTitle("2026-11-30")).toBe("Nov 30–Dec 6");
  });

  it("keeps proposals out of Mike's move count", () => {
    expect(bannerText(0, 0, true)).toBe("Drag blocks · nothing saves until Review");
    expect(bannerText(0, 2, true)).toBe("Agent suggests 2");
    expect(bannerText(0, 1, false)).toBe("Agent suggests 1");
    expect(bannerText(4, 1, false)).toBe("4 moves · agent suggests 1");
    expect(bannerText(1, 0, true)).toBe("1 move · unsaved");
    expect(approveLabel(4, 1)).toBe("Approve all · 4 moves + 1 proposal");
    expect(approveLabel(4, 0)).toBe("Approve all · 4 moves");
    expect(approveLabel(1, 2)).toBe("Approve all · 1 move + 2 proposals");
    expect(approveLabel(0, 2)).toBe("Approve all · 2 proposals");
    expect(approvedToast(4, 1)).toBe("Approved 4 moves + 1 proposal");
    expect(approvedToast(0, 2, ["Spec review"])).toBe("Approved 2 · Spec review changed");
    expect(approvedToast(1, 0)).toBe("Approved 1 move");
    expect(revertToast([])).toBe("Reverted. Nothing changed.");
    expect(revertToast(["Budget sheet"])).toBe("Reverted · Budget sheet not on calendar");
    expect(unplacedToast("Budget sheet")).toBe("Budget sheet · not on calendar");
    expect(unplacedToast("Budget sheet")).not.toMatch(/didn't move|→/);
    expect(compactConflict(1)).toBe("1 changed");
    expect(compactConflict(2)).toBe("2 changed");
    expect(partialPlanToast(2, 3, ["Spec review"])).toBe("Saved 2 of 3 · Spec review still in plan");
    expect(partialPlanToast(0, 1, ["Spec review"])).toBe("Spec review still in plan");
    expect(partialPlanToast(1, 2, ["Spec review", "Budget sheet"])).toBe("Saved 1 of 2 · Spec review and Budget sheet still in plan");
  });
});
