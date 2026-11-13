/** Full-day grid helpers: midnight clamp (AC 22a), DST rows (AC 22b), 15-minute snap. */

import { PX_PER_MINUTE, PlanTime, SNAP_MINUTES } from "../plan/time";
import { clock } from "../v3/format";

export const DEFAULT_TZ = "America/Indianapolis";

export interface DayHourRow {
  index: number;
  hour: number;
  label: string;
  startMinutes: number;
  spanMinutes: number;
  repeated?: boolean;
  skipped?: boolean;
}

export function snapStartMinutes(rawMinutes: number, previousMinutes?: number | null): number {
  const next = PlanTime.snapMinutes(rawMinutes);
  if (previousMinutes == null) return next;
  const boundary = (previousMinutes + next) / 2;
  if (Math.abs(rawMinutes - boundary) < SNAP_MINUTES / 2) return previousMinutes;
  return next;
}

/** Clamp so the block ends on or before the day's end — never past 12 AM (AC 22a). */
export function clampStartMinutes(
  startMinutes: number,
  durationMinutes: number,
  dayKey: string,
  timeZone: string,
): number {
  const dayLength = PlanTime.dayMinutes(dayKey, timeZone);
  let start = PlanTime.snapMinutes(startMinutes);
  if (start < 0) start = 0;
  const latest = Math.max(0, dayLength - durationMinutes);
  if (start > latest) start = PlanTime.snapMinutes(latest);
  if (start + durationMinutes > dayLength) {
    start = PlanTime.snapMinutes(dayLength - durationMinutes);
  }
  return Math.min(start, latest);
}

export function hourLabel(hour: number, repeated = false): string {
  const base = clock(hour, true).replace(/:00 /, " ");
  return repeated ? `${base} · again` : base;
}

export function dayHourRows(dayKey: string, timeZone: string): DayHourRow[] {
  const dayStart = PlanTime.midnight(dayKey, timeZone).getTime();
  const dayEnd = PlanTime.nextMidnight(dayKey, timeZone).getTime();
  const rows: DayHourRow[] = [];
  let lastHour: number | null = null;
  for (let index = 0, cursor = dayStart; cursor < dayEnd; index += 1, cursor += 3_600_000) {
    const hour = PlanTime.parts(new Date(cursor), timeZone).hour;
    const repeated = lastHour === hour;
  const nextCursor = Math.min(cursor + 3_600_000, dayEnd);
    rows.push({
      index,
      hour,
      label: hourLabel(hour, repeated),
      startMinutes: (cursor - dayStart) / 60_000,
      spanMinutes: (nextCursor - cursor) / 60_000,
      repeated: repeated || undefined,
    });
    lastHour = hour;
  }
  return rows;
}

/** Week view: one row per wall-clock hour; spring-forward days show a skipped 2 AM band. */
export function weekHourRows(dayKey: string, timeZone: string): DayHourRow[] {
  const dayRows = dayHourRows(dayKey, timeZone);
  const out: DayHourRow[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const matches = dayRows.filter((row) => row.hour === hour);
    if (matches.length === 0) {
      out.push({
        index: out.length,
        hour,
        label: hourLabel(hour),
        startMinutes: hour * 60,
        spanMinutes: 0,
        skipped: true,
      });
      continue;
    }
    for (const row of matches) {
      out.push({ ...row, index: out.length, repeated: undefined });
    }
  }
  return out;
}

export function isDstFallBackDay(dayKey: string, timeZone: string): boolean {
  return PlanTime.dayMinutes(dayKey, timeZone) === 25 * 60;
}

export function isDstSpringForwardDay(dayKey: string, timeZone: string): boolean {
  return PlanTime.dayMinutes(dayKey, timeZone) === 23 * 60;
}

/** Minutes-from-midnight to layout Y, using PlanTime's pixel scale. */
export function minutesToY(minutes: number): number {
  return minutes * PX_PER_MINUTE;
}
