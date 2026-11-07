/** Grid geometry and display-zone clock math. One pixel scale for the whole plan. */

export const SNAP_MINUTES = 15;
export const PX_PER_SNAP = 18;
export const PX_PER_MINUTE = PX_PER_SNAP / SNAP_MINUTES;
export const MIN_BLOCK_PX = 18;
export const DEFAULT_MINUTES = 30;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export class PlanTime {
  static parts(instant: Date, timeZone: string): ZonedParts {
    const bag: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant)) {
      if (part.type !== "literal") bag[part.type] = part.value;
    }
    let hour = Number(bag.hour);
    if (hour === 24) hour = 0;
    return {
      year: Number(bag.year),
      month: Number(bag.month),
      day: Number(bag.day),
      hour,
      minute: Number(bag.minute),
      second: Number(bag.second),
    };
  }

  static offsetMinutes(instant: Date, timeZone: string): number {
    const part = PlanTime.parts(instant, timeZone);
    const asUtc = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
    return Math.round((asUtc - instant.getTime()) / 60000);
  }

  static offsetLabel(instant: Date, timeZone: string): string {
    const minutes = PlanTime.offsetMinutes(instant, timeZone);
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    const hours = String(Math.floor(abs / 60)).padStart(2, "0");
    const mins = String(abs % 60).padStart(2, "0");
    return `${sign}${hours}:${mins}`;
  }

  /** Local clock to UTC. Null when that clock time does not exist (spring forward). */
  static localToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string,
  ): Date | null {
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    let utc = desired;
    for (let pass = 0; pass < 4; pass += 1) {
      const offset = PlanTime.offsetMinutes(new Date(utc), timeZone);
      utc = desired - offset * 60000;
    }
    const resolved = new Date(utc);
    const part = PlanTime.parts(resolved, timeZone);
    if (
      part.year !== year
      || part.month !== month
      || part.day !== day
      || part.hour !== hour
      || part.minute !== minute
    ) {
      return null;
    }
    return resolved;
  }

  static dayKey(instant: Date, timeZone: string): string {
    const part = PlanTime.parts(instant, timeZone);
    return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}`;
  }

  static addDaysToKey(dayKey: string, days: number): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + days));
    return shifted.toISOString().slice(0, 10);
  }

  static weekdayIndex(dayKey: string): number {
    const [year, month, day] = dayKey.split("-").map(Number);
    const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return (js + 6) % 7;
  }

  static mondayKey(dayKey: string): string {
    return PlanTime.addDaysToKey(dayKey, -PlanTime.weekdayIndex(dayKey));
  }

  static visibleDayKeys(anchorKey: string, mode: "week" | "day"): string[] {
    if (mode === "day") return [anchorKey];
    const monday = PlanTime.mondayKey(anchorKey);
    return Array.from({ length: 7 }, (_, index) => PlanTime.addDaysToKey(monday, index));
  }

  static midnight(dayKey: string, timeZone: string): Date {
    const [year, month, day] = dayKey.split("-").map(Number);
    const instant = PlanTime.localToUtc(year, month, day, 0, 0, timeZone);
    if (!instant) throw new Error(`No midnight for ${dayKey}`);
    return instant;
  }

  static nextMidnight(dayKey: string, timeZone: string): Date {
    return PlanTime.midnight(PlanTime.addDaysToKey(dayKey, 1), timeZone);
  }

  static dayMinutes(dayKey: string, timeZone: string): number {
    const start = PlanTime.midnight(dayKey, timeZone).getTime();
    const end = PlanTime.nextMidnight(dayKey, timeZone).getTime();
    return (end - start) / 60000;
  }

  static hourTicks(dayKey: string, timeZone: string): { hour: number; top: number }[] {
    const start = PlanTime.midnight(dayKey, timeZone).getTime();
    const end = PlanTime.nextMidnight(dayKey, timeZone).getTime();
    const ticks: { hour: number; top: number }[] = [];
    for (let cursor = start; cursor < end; cursor += 60 * 60 * 1000) {
      ticks.push({
        hour: PlanTime.parts(new Date(cursor), timeZone).hour,
        top: PlanTime.yPx((cursor - start) / 60000),
      });
    }
    return ticks;
  }

  static yPx(minutes: number): number {
    return minutes * PX_PER_MINUTE;
  }

  static blockHeightPx(minutes: number): number {
    return Math.max(MIN_BLOCK_PX, minutes * PX_PER_MINUTE);
  }

  static snapMinutes(minutes: number): number {
    return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  }

  static minutesFromEstimate(hours: number | null | undefined): number {
    if (hours == null || !Number.isFinite(hours) || hours <= 0) return DEFAULT_MINUTES;
    return Math.min(12 * 60, Math.max(1, Math.round(hours * 60)));
  }

  static slice(
    start: Date,
    end: Date,
    dayKey: string,
    timeZone: string,
  ): { top: number; height: number } | null {
    const dayStart = PlanTime.midnight(dayKey, timeZone).getTime();
    const dayEnd = PlanTime.nextMidnight(dayKey, timeZone).getTime();
    const from = Math.max(start.getTime(), dayStart);
    const to = Math.min(end.getTime(), dayEnd);
    if (to <= from) return null;
    return {
      top: PlanTime.yPx((from - dayStart) / 60000),
      height: PlanTime.blockHeightPx((to - from) / 60000),
    };
  }

  static dayHeightPx(dayKey: string, timeZone: string): number {
    return PlanTime.yPx(PlanTime.dayMinutes(dayKey, timeZone));
  }

  static initialScrollTop(dayKeys: string[], now: Date, timeZone: string, viewportPx: number): number {
    const nine = PlanTime.yPx(9 * 60);
    let top = nine;
    const todayKey = PlanTime.dayKey(now, timeZone);
    if (dayKeys.includes(todayKey)) {
      const minutes = (now.getTime() - PlanTime.midnight(todayKey, timeZone).getTime()) / 60000;
      if (minutes >= 7 * 60 && minutes <= 20 * 60) {
        top = PlanTime.yPx(minutes) - viewportPx / 2;
      }
    }
    const tallest = dayKeys.reduce((max, key) => Math.max(max, PlanTime.dayHeightPx(key, timeZone)), 0);
    const maxScroll = Math.max(0, tallest - viewportPx);
    return Math.min(Math.max(0, top), maxScroll);
  }

  static toUtcIso(instant: Date): string {
    return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  static formatDay(instant: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).formatToParts(instant);
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${read("weekday")} ${read("month")} ${read("day")}`;
  }

  static formatTime(instant: Date, timeZone: string): string {
    const part = PlanTime.parts(instant, timeZone);
    return `${part.hour}:${String(part.minute).padStart(2, "0")}`;
  }

  static formatHour(hour: number): string {
    return `${hour}:00`;
  }

  static rangeLabel(dayKeys: string[], timeZone: string): string {
    if (dayKeys.length === 0) return "";
    const first = PlanTime.midnight(dayKeys[0], timeZone);
    if (dayKeys.length === 1) return PlanTime.formatDay(first, timeZone);
    const last = PlanTime.midnight(dayKeys[dayKeys.length - 1], timeZone);
    return `${PlanTime.formatDay(first, timeZone)} – ${PlanTime.formatDay(last, timeZone)}`;
  }

  static blockLabel(title: string, start: Date, end: Date, timeZone: string, proposed: boolean): string {
    const when = `${PlanTime.formatDay(start, timeZone)}, ${PlanTime.formatTime(start, timeZone)}–${PlanTime.formatTime(end, timeZone)}`;
    return proposed ? `${title}, ${when}, Proposed` : `${title}, ${when}`;
  }
}
