import { describe, expect, it } from "vitest";

import { PlanTime } from "../plan/time";
import {
  DEFAULT_TZ,
  clampStartMinutes,
  dayHourRows,
  isDstFallBackDay,
  isDstSpringForwardDay,
  snapStartMinutes,
  weekHourRows,
} from "./dayRange";

describe("dayRange", () => {
  it("clamps a 30-minute block so it cannot end past midnight", () => {
    const dayKey = "2026-11-10";
    const raw = 23 * 60 + 45;
    expect(clampStartMinutes(raw, 30, dayKey, DEFAULT_TZ)).toBe(23 * 60 + 30);
    expect(clampStartMinutes(23 * 60 + 50, 60, dayKey, DEFAULT_TZ)).toBe(23 * 60);
  });

  it("snaps to 15 minutes with hysteresis", () => {
    expect(snapStartMinutes(1422)).toBe(1425);
    expect(snapStartMinutes(1428, 1425)).toBe(1425);
    expect(snapStartMinutes(1444, 1425)).toBe(1440);
  });

  it("renders 25 hour rows on fall-back Sun Nov 1 2026 with a repeated 1 AM", () => {
    const dayKey = "2026-11-01";
    expect(isDstFallBackDay(dayKey, DEFAULT_TZ)).toBe(true);
    expect(PlanTime.dayMinutes(dayKey, DEFAULT_TZ)).toBe(25 * 60);
    const rows = dayHourRows(dayKey, DEFAULT_TZ);
    expect(rows).toHaveLength(25);
    const oneAm = rows.filter((row) => row.hour === 1);
    expect(oneAm).toHaveLength(2);
    expect(oneAm[0].label).toMatch(/^1 AM\b/);
    expect(oneAm[1].label).toBe("1 AM · again");
    expect(oneAm[1].repeated).toBe(true);
  });

  it("renders 23 hour rows on spring-forward Sun Mar 14 2027 without 2 AM", () => {
    const dayKey = "2027-03-14";
    expect(isDstSpringForwardDay(dayKey, DEFAULT_TZ)).toBe(true);
    expect(PlanTime.dayMinutes(dayKey, DEFAULT_TZ)).toBe(23 * 60);
    const rows = dayHourRows(dayKey, DEFAULT_TZ);
    expect(rows).toHaveLength(23);
    expect(rows.map((row) => row.hour)).not.toContain(2);
    const week = weekHourRows(dayKey, DEFAULT_TZ);
    const two = week.find((row) => row.hour === 2);
    expect(two?.skipped).toBe(true);
    expect(two?.spanMinutes).toBe(0);
  });
});
