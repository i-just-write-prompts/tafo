/** Day and week geometry from the approved v3 frames. Sizes are CSS pixels at 1x. */

export const DAY_PX = 60;
export const DAY_ORIGIN = 8.5;
export const DAY_GUTTER = 56;
export const DAY_X0 = DAY_GUTTER + 4;
export const DAY_RIGHT = 10;
export const DAY_GAP = 6;
export const WEEK_GUTTER = 36;
export const WEEK_PX = 49.5;
export const WEEK_ORIGIN = 8;
export const WEEK_END = 20;
export const WEEK_STRIP = 9;
export const WEEK_LANE_GAP = 2;
export const WORK_START = 9;
export const WORK_END = 17;
export const PHONE_WIDTH = 390;

export interface Timed {
  id: string;
  start: number;
  end: number;
}

export interface DayBox {
  id: string;
  lane: number;
  lanes: number;
  x: number;
  y: number;
  w: number;
  h: number;
  slotY: number;
  slotH: number;
}

export interface TapBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WeekBox {
  id: string;
  slim: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function snapHour(hour: number): number {
  return Math.round((hour + 1e-9) * 4) / 4;
}

/** Stay in the slot already on screen until the pointer is a few pixels past the boundary. */
export function snapHourStable(previous: number | null, raw: number, pxPerHour: number): number {
  const next = snapHour(raw);
  if (previous == null || Math.abs(next - previous) < 1e-9) return next;
  const boundary = (previous + next) / 2;
  if (Math.abs(raw - boundary) * pxPerHour < 6) return previous;
  return next;
}

export function dayY(hour: number): number {
  return (hour - DAY_ORIGIN) * DAY_PX;
}

export function weekY(hour: number): number {
  return (hour - WEEK_ORIGIN) * WEEK_PX;
}

export function drawnHeight(duration: number, px = DAY_PX): number {
  return duration * px - 2;
}

export function weekColumnWidth(width: number): number {
  return (width - WEEK_GUTTER - 2) / 7;
}

export function assignLanes(items: Timed[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const out = new Map<string, { lane: number; lanes: number }>();
  let index = 0;
  while (index < sorted.length) {
    const cluster = [sorted[index]];
    let end = sorted[index].end;
    let next = index + 1;
    while (next < sorted.length && sorted[next].start < end - 1e-9) {
      cluster.push(sorted[next]);
      end = Math.max(end, sorted[next].end);
      next += 1;
    }
    const laneEnds: number[] = [];
    const laneOf = new Map<string, number>();
    for (const event of cluster) {
      let placed = false;
      for (let lane = 0; lane < laneEnds.length; lane += 1) {
        if (event.start >= laneEnds[lane] - 1e-9) {
          laneEnds[lane] = event.end;
          laneOf.set(event.id, lane);
          placed = true;
          break;
        }
      }
      if (!placed) {
        laneOf.set(event.id, laneEnds.length);
        laneEnds.push(event.end);
      }
    }
    const lanes = laneEnds.length;
    for (const event of cluster) {
      out.set(event.id, { lane: laneOf.get(event.id) ?? 0, lanes });
    }
    index = next;
  }
  return out;
}

export function laneBox(lane: number, lanes: number, width: number): { x: number; w: number } {
  const avail = width - DAY_X0 - DAY_RIGHT;
  const inner = (avail - (lanes - 1) * DAY_GAP) / lanes;
  return { x: DAY_X0 + lane * (inner + DAY_GAP), w: inner };
}

export function dayBoxes(events: Timed[], width: number): DayBox[] {
  const lanes = assignLanes(events);
  return events.map((event) => {
    const place = lanes.get(event.id) ?? { lane: 0, lanes: 1 };
    const span = laneBox(place.lane, place.lanes, width);
    const slotY = dayY(event.start);
    const slotH = (event.end - event.start) * DAY_PX;
    return {
      id: event.id,
      lane: place.lane,
      lanes: place.lanes,
      x: span.x,
      y: slotY + 1,
      w: span.w,
      h: slotH - 2,
      slotY,
      slotH,
    };
  });
}

function xOverlap(a: DayBox, b: DayBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

function emptyRoom(box: DayBox, boxes: DayBox[], direction: "above" | "below"): number {
  let edge = direction === "above" ? 0 : box.slotY + box.slotH + 120;
  if (direction === "below") {
    for (const other of boxes) {
      if (other.id === box.id || !xOverlap(box, other)) continue;
      if (other.slotY >= box.slotY + box.slotH - 0.01) edge = Math.min(edge, other.slotY);
    }
    return Math.max(0, (edge - (box.slotY + box.slotH)) / 2);
  }
  for (const other of boxes) {
    if (other.id === box.id || !xOverlap(box, other)) continue;
    if (other.slotY + other.slotH <= box.slotY + 0.01) edge = Math.max(edge, other.slotY + other.slotH);
  }
  return Math.max(0, (box.slotY - edge) / 2);
}

function widened(box: DayBox, boxes: DayBox[]): { x: number; w: number } {
  let left = box.x;
  let right = box.x + box.w;
  for (const other of boxes) {
    if (other.id === box.id) continue;
    const vertical = other.slotY < box.slotY + box.slotH && box.slotY < other.slotY + other.slotH;
    if (!vertical) continue;
    if (other.x + other.w <= box.x + 0.01) {
      left = Math.min(left, (other.x + other.w + box.x) / 2);
    } else if (other.x >= box.x + box.w - 0.01) {
      right = Math.max(right, (box.x + box.w + other.x) / 2);
    }
  }
  return { x: left, w: right - left };
}

export function dayTaps(events: Timed[], width: number): TapBox[] {
  const boxes = dayBoxes(events, width);
  return boxes.map((box) => {
    let top = box.slotY;
    let bottom = box.slotY + box.slotH;
    if (box.slotH < 44) {
      const need = 44 - box.slotH;
      const above = emptyRoom(box, boxes, "above");
      const below = emptyRoom(box, boxes, "below");
      let up = Math.min(above, need / 2);
      const down = Math.min(below, need - up);
      up = Math.min(above, need - down);
      top -= up;
      bottom += down;
    }
    const span = widened(box, boxes);
    return { id: box.id, x: span.x, y: top, w: span.w, h: bottom - top };
  });
}

export function dayHit(events: Timed[], width: number, x: number, y: number): string | null {
  const taps = dayTaps(events, width);
  const boxes = dayBoxes(events, width);
  const hits = taps.filter((tap) => x >= tap.x && x < tap.x + tap.w && y >= tap.y && y < tap.y + tap.h);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0].id;
  const slotted = hits.filter((tap) => {
    const box = boxes.find((item) => item.id === tap.id);
    return box ? y >= box.slotY && y < box.slotY + box.slotH : false;
  });
  if (slotted.length === 1) return slotted[0].id;
  const pool = slotted.length ? slotted : hits;
  pool.sort((a, b) => Math.abs(y - (a.y + a.h / 2)) - Math.abs(y - (b.y + b.h / 2)));
  return pool[0].id;
}

export interface WeekEvent extends Timed {
  day: number;
}

export function weekBoxes(events: WeekEvent[], width: number): WeekBox[] {
  const colW = weekColumnWidth(width);
  const byDay = new Map<number, WeekEvent[]>();
  for (const event of events) {
    const list = byDay.get(event.day) ?? [];
    list.push(event);
    byDay.set(event.day, list);
  }
  const lanes = new Map<string, { lane: number; lanes: number }>();
  for (const list of byDay.values()) {
    for (const [id, place] of assignLanes(list)) lanes.set(id, place);
  }
  return events.map((event) => {
    const place = lanes.get(event.id) ?? { lane: 0, lanes: 1 };
    const colX = WEEK_GUTTER + event.day * colW;
    const inner = colW - 3;
    const laneW = (inner - (place.lanes - 1) * WEEK_LANE_GAP) / place.lanes;
    return {
      id: event.id,
      slim: false,
      x: colX + 1.5 + place.lane * (laneW + WEEK_LANE_GAP),
      y: weekY(event.start) + 1,
      w: laneW,
      h: Math.max(8, (event.end - event.start) * WEEK_PX - 2),
    };
  });
}

/** Title measure for a week column. It does not change when a lane appears. */
export function weekTitleWidth(width: number): number {
  return Math.max(8, weekColumnWidth(width) - 8);
}

export function inWorkHours(day: number, start: number, end: number): boolean {
  return day < 5 && start < WORK_END && end > WORK_START;
}

export function crossesWorkHours(
  domain: string,
  fromDay: number,
  fromStart: number,
  fromEnd: number,
  toDay: number,
  toStart: number,
  toEnd: number,
): boolean {
  return domain !== "work" && inWorkHours(toDay, toStart, toEnd) && !inWorkHours(fromDay, fromStart, fromEnd);
}

export function moveByPointer(input: {
  originStart: number;
  originDay: number;
  duration: number;
  deltaY: number;
  pointerX: number;
  pxPerHour: number;
  gutter: number;
  columnWidth: number;
  allowDayChange: boolean;
  previousSnap?: number | null;
}): { day: number; start: number } {
  const raw = input.originStart + input.deltaY / input.pxPerHour;
  let start = snapHourStable(input.previousSnap ?? null, raw, input.pxPerHour);
  const latest = 24 - input.duration;
  if (start < 0) start = 0;
  if (start > latest) start = snapHour(latest);
  if (start + input.duration > 24) start = snapHour(24 - input.duration);
  let day = input.originDay;
  if (input.allowDayChange && input.pointerX >= input.gutter) {
    const index = Math.floor((input.pointerX - input.gutter) / input.columnWidth);
    day = Math.min(6, Math.max(0, index));
  }
  return { day, start };
}

export function nearMark(markY: number | null, y: number, limit: number): boolean {
  return markY != null && Math.abs(markY - y) <= limit;
}
