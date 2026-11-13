/** All-day and multi-day detection for slice 1 (AC 32f). */

import { PlanTime } from "../plan/time";
import type { CalEvent } from "../v3/model";

export function isMultiDayEvent(event: CalEvent, timeZone: string): boolean {
  const startKey = PlanTime.dayKey(new Date(event.start), timeZone);
  const endInstant = new Date(event.end).getTime() - 60_000;
  const endKey = PlanTime.dayKey(new Date(endInstant), timeZone);
  return startKey !== endKey;
}

/** Wall-clock all-day: midnight start and at least 23 hours on the calendar day. */
export function isAllDayEvent(event: CalEvent, timeZone: string): boolean {
  if (isMultiDayEvent(event, timeZone)) return false;
  const start = PlanTime.parts(new Date(event.start), timeZone);
  if (start.hour !== 0 || start.minute !== 0) return false;
  const minutes = (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000;
  return minutes >= 23 * 60;
}

export function coversDayKey(event: CalEvent, dayKey: string, timeZone: string): boolean {
  const startKey = PlanTime.dayKey(new Date(event.start), timeZone);
  const endKey = PlanTime.dayKey(new Date(new Date(event.end).getTime() - 60_000), timeZone);
  return dayKey >= startKey && dayKey <= endKey;
}

export function multiDayLabel(event: CalEvent, timeZone: string): string {
  const startKey = PlanTime.dayKey(new Date(event.start), timeZone);
  const endKey = PlanTime.dayKey(new Date(new Date(event.end).getTime() - 60_000), timeZone);
  const fmt = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  return `${event.title} · ${fmt(startKey)}–${fmt(endKey)}`;
}
