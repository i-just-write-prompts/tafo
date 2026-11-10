import { describe, expect, it } from "vitest";

import {
  crossesWorkHours,
  dayBoxes,
  dayHit,
  dayTaps,
  dayY,
  drawnHeight,
  moveByPointer,
  snapHour,
  weekBoxes,
  WEEK_LANE_GAP,
} from "./geometry";

const tuesday = [
  { id: "t1", start: 9, end: 9.5 },
  { id: "spec", start: 9.5, end: 11 },
  { id: "t3", start: 10, end: 10.5 },
  { id: "lunch", start: 12, end: 13 },
];

describe("day geometry", () => {
  it("draws a 30-minute block at 28px on a 30px slot", () => {
    const boxes = dayBoxes(tuesday, 390);
    const standup = boxes.find((box) => box.id === "t1");
    const spec = boxes.find((box) => box.id === "spec");
    expect(standup).toBeTruthy();
    expect(spec).toBeTruthy();
    expect(drawnHeight(0.5)).toBe(28);
    expect(standup?.h).toBe(28);
    expect(standup?.slotH).toBe(30);
    expect((spec?.slotY ?? 0) - ((standup?.slotY ?? 0) + (standup?.slotH ?? 0))).toBe(0);
    expect((spec?.y ?? 0) - ((standup?.y ?? 0) + (standup?.h ?? 0))).toBe(2);
  });

  it("splits the 9:30 boundary between Standup and Spec review", () => {
    const y929 = dayY(9 + 29 / 60);
    const y931 = dayY(9 + 31 / 60);
    expect(dayHit(tuesday, 390, 80, y929)).toBe("t1");
    expect(dayHit(tuesday, 390, 80, y931)).toBe("spec");
    expect(dayHit(tuesday, 390, 300, dayY(10.25))).toBe("t3");
  });

  it("extends a short block into empty grid and not into its neighbour", () => {
    const taps = dayTaps([{ id: "herbs", start: 18, end: 18.5 }], 390);
    expect(taps[0].h).toBeGreaterThanOrEqual(44);
    const packed = dayTaps(tuesday, 390);
    const standup = packed.find((tap) => tap.id === "t1");
    const spec = packed.find((tap) => tap.id === "spec");
    expect(standup && spec && standup.y + standup.h).toBeLessThanOrEqual(spec.y + 0.01);
  });

  it("gives overlapping events equal lanes and full width once they separate", () => {
    const overlap = dayBoxes(tuesday, 390);
    const spec = overlap.find((box) => box.id === "spec");
    const vendor = overlap.find((box) => box.id === "t3");
    expect(spec?.lanes).toBe(2);
    expect(vendor?.lane).toBe(1);
    const separated = dayBoxes(
      tuesday.map((event) => (event.id === "t3" ? { ...event, start: 11, end: 11.5 } : event)),
      390,
    );
    expect(separated.find((box) => box.id === "spec")?.lanes).toBe(1);
    expect(separated.find((box) => box.id === "t3")?.lanes).toBe(1);
  });
});

describe("week geometry and drag", () => {
  it("keeps a 2px gap before the slim overlap", () => {
    const boxes = weekBoxes(
      [
        { id: "h2", day: 3, start: 10, end: 11.5 },
        { id: "h5", day: 3, start: 10.5, end: 11 },
      ],
      390,
    );
    const main = boxes.find((box) => box.id === "h2");
    const nub = boxes.find((box) => box.id === "h5");
    expect(nub?.slim).toBe(true);
    expect(main && nub ? nub.x - (main.x + main.w) : 0).toBeCloseTo(WEEK_LANE_GAP, 5);
  });

  it("snaps to 15 minutes and can change day only in week", () => {
    expect(snapHour(10.74)).toBe(10.75);
    const down = moveByPointer({
      originStart: 10,
      originDay: 1,
      duration: 0.5,
      deltaY: 60,
      pointerX: 80,
      pxPerHour: 60,
      gutter: 56,
      columnWidth: 50,
      allowDayChange: false,
    });
    expect(down).toEqual({ day: 1, start: 11 });
    const across = moveByPointer({
      originStart: 9.5,
      originDay: 1,
      duration: 1.5,
      deltaY: 0,
      pointerX: 36 + 50.2857 * 2 + 10,
      pxPerHour: 49.5,
      gutter: 36,
      columnWidth: 50.2857,
      allowDayChange: true,
    });
    expect(across.day).toBe(2);
    expect(across.start).toBe(9.5);
  });

  it("flags a personal block that newly crosses work hours", () => {
    expect(crossesWorkHours("personal", 4, 18, 19, 3, 16.5, 17.5)).toBe(true);
    expect(crossesWorkHours("work", 1, 9.5, 11, 2, 9.5, 11)).toBe(false);
    expect(crossesWorkHours("personal", 1, 12, 13, 3, 12, 13)).toBe(false);
  });
});
