import { describe, expect, it } from "vitest";
import { DEFAULT_MINUTES, MIN_BLOCK_PX, PX_PER_MINUTE, PlanTime } from "./time";

const TZ = "America/Indianapolis";

describe("plan time", () => {
  it("sizes blocks from one pixels-per-minute constant, with a floor under 15 minutes", () => {
    expect(PX_PER_MINUTE).toBeCloseTo(1.2, 5);
    expect(PlanTime.blockHeightPx(60)).toBe(60 * PX_PER_MINUTE);
    expect(PlanTime.blockHeightPx(30) * 2).toBe(PlanTime.blockHeightPx(60));
    expect(PlanTime.blockHeightPx(10)).toBe(MIN_BLOCK_PX);
    expect(PlanTime.blockHeightPx(15)).toBe(MIN_BLOCK_PX);
    expect(PlanTime.minutesFromEstimate(null)).toBe(DEFAULT_MINUTES);
    expect(PlanTime.minutesFromEstimate(undefined)).toBe(30);
    expect(PlanTime.minutesFromEstimate(0)).toBe(30);
    expect(PlanTime.minutesFromEstimate(1.5)).toBe(90);
  });

  it("clips a block that crosses midnight onto each day", () => {
    const start = PlanTime.localToUtc(2027, 3, 10, 23, 30, TZ);
    const end = PlanTime.localToUtc(2027, 3, 11, 0, 30, TZ);
    expect(start && end).toBeTruthy();
    const first = PlanTime.slice(start!, end!, "2027-03-10", TZ);
    const second = PlanTime.slice(start!, end!, "2027-03-11", TZ);
    expect(first && (first.height)).toBe(30 * PX_PER_MINUTE);
    expect(second && second.height).toBe(30 * PX_PER_MINUTE);
  });

  it("lays out the spring-forward week of Mar 8 2027 without a phantom 2 AM", () => {
    const days = PlanTime.visibleDayKeys("2027-03-08", "week");
    expect(days[0]).toBe("2027-03-08");
    expect(days[6]).toBe("2027-03-14");
    expect(PlanTime.dayMinutes("2027-03-14", TZ)).toBe(23 * 60);
    expect(PlanTime.dayMinutes("2027-03-08", TZ)).toBe(24 * 60);
    const ticks = PlanTime.hourTicks("2027-03-14", TZ);
    expect(ticks.map((tick) => tick.hour)).not.toContain(2);
    expect(ticks).toHaveLength(23);
    expect(PlanTime.localToUtc(2027, 3, 14, 2, 30, TZ)).toBeNull();
    const start = PlanTime.localToUtc(2027, 3, 14, 1, 30, TZ)!;
    const end = PlanTime.localToUtc(2027, 3, 14, 3, 30, TZ)!;
    expect((end.getTime() - start.getTime()) / 60000).toBe(60);
    expect(PlanTime.offsetLabel(start, TZ)).toBe("-05:00");
    expect(PlanTime.offsetLabel(end, TZ)).toBe("-04:00");
    const slice = PlanTime.slice(start, end, "2027-03-14", TZ)!;
    expect(slice.height).toBe(60 * PX_PER_MINUTE);
  });

  it("lays out the fall-back morning of Nov 7 2027 as three real hours", () => {
    expect(PlanTime.dayMinutes("2027-11-07", TZ)).toBe(25 * 60);
    const ticks = PlanTime.hourTicks("2027-11-07", TZ);
    expect(ticks).toHaveLength(25);
    expect(ticks.filter((tick) => tick.hour === 1)).toHaveLength(2);
    const start = PlanTime.localToUtc(2027, 11, 7, 0, 30, TZ)!;
    const end = PlanTime.localToUtc(2027, 11, 7, 2, 30, TZ)!;
    expect((end.getTime() - start.getTime()) / 60000).toBe(180);
    expect(PlanTime.offsetLabel(start, TZ)).toBe("-04:00");
    expect(PlanTime.offsetLabel(end, TZ)).toBe("-05:00");
    const slice = PlanTime.slice(start, end, "2027-11-07", TZ)!;
    expect(slice.height).toBe(180 * PX_PER_MINUTE);
  });

  it("opens on 9:00, or centers the now-line when today is in range", () => {
    const week = PlanTime.visibleDayKeys("2026-11-02", "week");
    const evening = PlanTime.localToUtc(2026, 11, 4, 21, 0, TZ)!;
    expect(PlanTime.initialScrollTop(week, evening, TZ, 600)).toBe(PlanTime.yPx(9 * 60));
    const noon = PlanTime.localToUtc(2026, 11, 4, 12, 0, TZ)!;
    const nowPx = PlanTime.yPx((noon.getTime() - PlanTime.midnight("2026-11-04", TZ).getTime()) / 60000);
    expect(PlanTime.initialScrollTop(week, noon, TZ, 600)).toBe(nowPx - 300);
    const nextWeek = PlanTime.visibleDayKeys("2026-11-09", "week");
    expect(PlanTime.initialScrollTop(nextWeek, noon, TZ, 600)).toBe(PlanTime.yPx(9 * 60));
    const early = PlanTime.localToUtc(2026, 11, 4, 6, 30, TZ)!;
    expect(PlanTime.initialScrollTop(week, early, TZ, 600)).toBe(PlanTime.yPx(9 * 60));
  });

  it("formats a human date", () => {
    const instant = PlanTime.localToUtc(2026, 11, 7, 9, 0, TZ)!;
    expect(PlanTime.formatDay(instant, TZ)).toBe("Sat Nov 7");
    expect(PlanTime.formatTime(instant, TZ)).toBe("9:00");
  });
});
