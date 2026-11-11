// Week-view overlap repro. Visible blocks must not paint over each other
// when a calendar between them is hidden.
import { describe, expect, it } from "vitest";
import { dayBoxes, paintedWeekSpan, weekBoxes, type WeekEvent } from "./geometry";

const starts = Array.from({ length: 9 }, (_, i) => 9 + i * 0.25);
const lengths = [0.25, 0.5, 1];
const slots = starts.flatMap((s) => lengths.map((l) => [s, s + l] as const));
const timeOverlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end - 1e-9 && b.start < a.end - 1e-9;
const rectOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

function* layouts(): Generator<WeekEvent[]> {
  for (const a of slots) for (const b of slots) for (const c of slots)
    yield [
      { id: "a", day: 1, start: a[0], end: a[1] },
      { id: "b", day: 1, start: b[0], end: b[1] },
      { id: "c", day: 1, start: c[0], end: c[1] },
    ];
}

describe("B2 overlaps are never hidden", () => {
  it("B2-W minimal: three blocks at the same time, middle calendar hidden", () => {
    const events: WeekEvent[] = ["a", "b", "c"].map((id) => ({ id, day: 1, start: 9, end: 10 }));
    const boxes = weekBoxes(events, 390);
    const visible = new Set(["a", "c"]);
    const [a, , c] = boxes.map((box) => ({ ...box, ...paintedWeekSpan(box, boxes, visible, 390) }));
    expect(rectOverlap(a, c)).toBe(false);
  });

  it("day view: two blocks that overlap in time never paint over each other", () => {
    for (const width of [390, 1280]) for (const events of layouts()) {
      const boxes = dayBoxes(events, width);
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
        if (timeOverlap(events[i], events[j]))
          expect(rectOverlap(boxes[i], boxes[j]), JSON.stringify(events)).toBe(false);
    }
  });

  it("B2-W week view: visible blocks never paint over each other, with any calendar hidden", () => {
    const failures: string[] = [];
    for (const width of [390, 1280]) for (const events of layouts()) {
      const boxes = weekBoxes(events, width);
      for (const mask of [0b111, 0b110, 0b101, 0b011]) {
        const visible = new Set(events.filter((_, k) => mask & (1 << k)).map((e) => e.id));
        const painted = boxes.map((box) => ({ ...box, ...paintedWeekSpan(box, boxes, visible, width) }));
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
          if (!visible.has(events[i].id) || !visible.has(events[j].id)) continue;
          if (rectOverlap(painted[i], painted[j]) && failures.length < 3)
            failures.push(`${width}px visible=${[...visible]} ${JSON.stringify(events.map((e) => [e.id, e.start, e.end]))}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
