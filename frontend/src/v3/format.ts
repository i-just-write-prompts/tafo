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

function withMinutes(label: string): string {
  const space = label.lastIndexOf(" ");
  const body = space === -1 ? label : label.slice(0, space);
  const suffix = space === -1 ? "" : label.slice(space);
  const timed = body.includes(":") ? body : `${body}:00`;
  return `${timed}${suffix}`;
}

export function rangeLabel(start: number, end: number): string {
  const aFull = withMinutes(clock(start));
  const bFull = withMinutes(clock(end));
  const a = aFull.slice(-2) === bFull.slice(-2) ? aFull.slice(0, -3) : aFull;
  return `${a}–${bFull}`;
}

export function shortRange(start: number, end: number): string {
  return `${clock(start, false)}–${clock(end, false)}`;
}

export function quickToast(title: string, startHour: number): string {
  return `${title} → ${clockMinutes(startHour)}`;
}

/** A refused calendar write. No arrow: an arrow is the saved-move claim. */
export function refusedMoveToast(title: string): string {
  return `${title} didn't move.`;
}

/** An approved proposal whose calendar create did not land. No arrow. */
export function unplacedToast(title: string): string {
  return `${title} · not on calendar`;
}

/** Narrow plan banner. The name stays on the Review sheet's Changed tag. */
export function compactConflict(count: number): string {
  return `${count} changed`;
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
  if (moves === 0) return `Approve all · ${plural(proposals, "proposal")}`;
  if (proposals === 0) return `Approve all · ${plural(moves, "move")}`;
  return `Approve all · ${plural(moves, "move")} + ${plural(proposals, "proposal")}`;
}

export function approvedToast(moves: number, proposals: number, held: string[] = []): string {
  const parts: string[] = [];
  if (moves > 0) parts.push(plural(moves, "move"));
  if (proposals > 0) parts.push(plural(proposals, "proposal"));
  if (held.length > 0) {
    const count = moves + proposals;
    const saved = count > 0 ? `Approved ${count}` : "Approved";
    return `${saved} · ${joinedNames(held)} changed`;
  }
  const saved = parts.length === 0 ? "Approved" : `Approved ${parts.join(" + ")}`;
  return saved;
}

function joinedNames(names: string[]): string {
  if (names.length <= 1) return names[0] || "A move";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Names the moves that stayed in the draft. The event name may ellipsize; "still in plan" must not. */
export function partialPlanToast(saved: number, requested: number, unsaved: string[]): string {
  const names = joinedNames(unsaved);
  const tail = `${names} still in plan`;
  if (saved <= 0) return tail;
  return `Saved ${saved} of ${requested} · ${tail}`;
}

export const SAVED_REFRESH = "Saved · refreshing the calendar";

export function denyToast(title: string): string {
  return `Denied · ${title} → Unscheduled`;
}
export const REVERT_TOAST = "Reverted. Nothing changed.";

export function revertToast(unsynced: string[]): string {
  if (unsynced.length === 0) return REVERT_TOAST;
  return `Reverted · ${joinedNames(unsynced)} not on calendar`;
}
export const SYNC_DEMO = "Demo · not synced";
export const TIP_TEXT = "Moving several? Try Plan";
export const PLAN_HINT = "Move several blocks, then approve or revert them together";
