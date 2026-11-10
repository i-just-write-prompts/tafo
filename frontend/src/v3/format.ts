import { PlanTime } from "../plan/time";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Match the approved frames: "9 AM", "9:30 AM", "10:45". */
export function clock(hour: number, ampm = true): string {
  let hh = Math.trunc(hour);
  let mm = Math.round((hour - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  const suffix = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 || 12;
  const body = mm ? `${h12}:${String(mm).padStart(2, "0")}` : `${h12}`;
  return ampm ? `${body} ${suffix}` : body;
}

export function clockMinutes(hour: number): string {
  let hh = Math.trunc(hour);
  let mm = Math.round((hour - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  const suffix = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

export function exactClock(hour: number): string {
  let hh = Math.floor(hour + 1e-6);
  let mm = Math.round((hour - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm).padStart(2, "0")}`;
}

export function gutterClock(hour: number): string {
  const snapped = Math.round(hour * 4) / 4;
  let hh = Math.trunc(snapped);
  let mm = Math.round((snapped - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm).padStart(2, "0")}`;
}

export function rangeLabel(start: number, end: number): string {
  let a = clock(start);
  const b = clock(end);
  if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -3);
  if (!a.includes(":")) a = `${a}:00`;
  const head = b.split(" ")[0];
  const b2 = head.includes(":") ? b : b.replace(" ", ":00 ");
  return `${a}–${b2}`;
}

export function shortRange(start: number, end: number): string {
  return `${clock(start, false)}–${clock(end, false)}`;
}

export function quickToast(title: string, startHour: number): string {
  return `${title} → ${clockMinutes(startHour)}`;
}

export function dayName(dayKey: string): string {
  return DAYS[PlanTime.weekdayIndex(dayKey)];
}

export function dayTitle(dayKey: string): string {
  const [, month, day] = dayKey.split("-").map(Number);
  return `${dayName(dayKey)}, ${MONTHS[month - 1]} ${day}`;
}

export function weekTitle(mondayKey: string): string {
  const endKey = PlanTime.addDaysToKey(mondayKey, 6);
  const [, startMonth, startDay] = mondayKey.split("-").map(Number);
  const [, endMonth, endDay] = endKey.split("-").map(Number);
  if (startMonth === endMonth) return `${MONTHS[startMonth - 1]} ${startDay}–${endDay}`;
  return `${MONTHS[startMonth - 1]} ${startDay}–${MONTHS[endMonth - 1]} ${endDay}`;
}

export function sheetDate(dayKey: string): string {
  return dayTitle(dayKey);
}

export function domainLabel(domain: string): string {
  if (domain === "work") return "Work";
  if (domain === "home") return "Home";
  return "Personal";
}

export function nubLabel(title: string, start: number, end: number): string {
  return `+1 more event: ${title}, ${compactRange(start, end)}`;
}

/** The spoken week-nub form: "10:30–11 AM". */
export function compactRange(start: number, end: number): string {
  const a = clock(start);
  const b = clock(end);
  const aBody = a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a;
  const bBody = clock(end, false);
  const bShown = bBody.includes(":") ? b : `${bBody} ${b.slice(-2)}`;
  return `${aBody}–${bShown}`;
}

export function dragReadout(title: string, day: string, start: number, end: number): string {
  return `${title} · ${day} ${rangeLabel(start, end)}`;
}

export function bannerText(moves: number, proposals: number, unsavedFits: boolean): string {
  if (moves === 0) return "Drag blocks · nothing saves until Review";
  const base = `${plural(moves, "move")}${proposals ? ` · agent suggests ${proposals}` : ""}`;
  return unsavedFits ? `${base} · unsaved` : base;
}

export function approveLabel(moves: number, proposals: number): string {
  if (proposals === 0) return `Approve all · ${plural(moves, "move")}`;
  return `Approve all · ${plural(moves, "move")} + ${plural(proposals, "proposal")}`;
}

export function approvedToast(moves: number, proposals: number): string {
  if (proposals === 0) return `Approved ${plural(moves, "move")}`;
  return `Approved ${plural(moves, "move")} + ${plural(proposals, "proposal")}`;
}

export function denyToast(title: string): string {
  return `Denied · ${title} moved to Unscheduled`;
}
export const REVERT_TOAST = "Reverted. Nothing changed.";
export const SYNC_DEMO = "Demo · not synced";
export const TIP_TEXT = "Moving several? Try Plan";
export const PLAN_HINT = "Move several blocks, then approve or revert them together";
