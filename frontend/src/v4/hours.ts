import type { CategoryHourSpan, HoursPayload, SacredWindow } from "./hoursTypes";

export interface HeadsUpTag {
  kind: "home-hours" | "work-hours" | "sacred";
  label: string;
  trayLine: string;
}

export function inCategoryHours(
  hours: CategoryHourSpan[],
  domain: string,
  weekday: number,
  startMin: number,
  endMin: number,
): boolean {
  const spans = hours.filter((row) => row.domain === domain && row.weekday === weekday);
  if (spans.length === 0) return true;
  return spans.some((row) => startMin >= row.start_minutes && endMin <= row.end_minutes);
}

export function sacredOverlap(
  windows: SacredWindow[],
  weekday: number,
  startMin: number,
  endMin: number,
): SacredWindow | null {
  for (const window of windows) {
    if ((window.days_mask & (1 << weekday)) === 0) continue;
    if (endMin <= window.start_minutes || startMin >= window.end_minutes) continue;
    return window;
  }
  return null;
}

export function headsUpForMove(
  payload: HoursPayload | null,
  domain: string,
  weekday: number,
  startHour: number,
  endHour: number,
  sacredHeadsUp = true,
): HeadsUpTag | null {
  if (!payload) return null;
  const startMin = Math.round(startHour * 60);
  const endMin = Math.round(endHour * 60);
  const sacred = sacredOverlap(payload.sacred_windows, weekday, startMin, endMin);
  if (sacred && sacredHeadsUp && sacred.heads_up) {
    return { kind: "sacred", label: sacred.name, trayLine: `In ${sacred.name}` };
  }
  const inOwn = inCategoryHours(payload.category_hours, domain, weekday, startMin, endMin);
  if (inOwn) return null;
  if (domain === "work" && inCategoryHours(payload.category_hours, "home", weekday, startMin, endMin)) {
    return { kind: "home-hours", label: "Home hours", trayLine: "In your home hours" };
  }
  if (domain === "home" && inCategoryHours(payload.category_hours, "work", weekday, startMin, endMin)) {
    return { kind: "work-hours", label: "Work hours", trayLine: "In your work hours" };
  }
  if (domain === "personal" && inCategoryHours(payload.category_hours, "work", weekday, startMin, endMin)) {
    return { kind: "work-hours", label: "Work hours", trayLine: "In your work hours" };
  }
  return null;
}

export function blockOutsideHours(
  payload: HoursPayload | null,
  domain: string,
  weekday: number,
  startHour: number,
  endHour: number,
): boolean {
  return headsUpForMove(payload, domain, weekday, startHour, endHour) !== null;
}
