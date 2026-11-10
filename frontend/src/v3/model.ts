import type { CalendarBlock, Domain, Proposal, Task } from "../types";
import { PlanBoard } from "../plan/selectors";
import { PlanTime } from "../plan/time";

export interface CalEvent {
  id: string;
  kind: "block" | "proposal";
  title: string;
  domain: Domain;
  start: string;
  end: string;
  state: "approved" | "proposed" | "done";
  taskId: string | null;
  version: number;
  fixed: boolean;
  explanation: string;
  dayKey: string;
  startHour: number;
  endHour: number;
}

export interface ShowFilters {
  work: boolean;
  home: boolean;
  personal: boolean;
  proposals: boolean;
}

export const ALL_SHOWN: ShowFilters = { work: true, home: true, personal: true, proposals: true };

function hours(iso: string, timeZone: string): { dayKey: string; hour: number } {
  const instant = new Date(iso);
  const part = PlanTime.parts(instant, timeZone);
  return { dayKey: PlanTime.dayKey(instant, timeZone), hour: part.hour + part.minute / 60 + part.second / 3600 };
}

function span(start: string, end: string, timeZone: string): { dayKey: string; startHour: number; endHour: number } {
  const opened = hours(start, timeZone);
  const closed = hours(end, timeZone);
  let endHour = closed.hour;
  if (closed.dayKey !== opened.dayKey) endHour += 24;
  return { dayKey: opened.dayKey, startHour: opened.hour, endHour };
}

export function buildEvents(
  tasks: Task[],
  blocks: CalendarBlock[],
  proposals: Proposal[],
  timeZone: string,
): CalEvent[] {
  const events: CalEvent[] = [];
  for (const block of blocks) {
    if (block.status !== "scheduled") continue;
    const task = tasks.find((item) => item.id === block.task_id);
    const place = span(block.starts_at, block.ends_at, timeZone);
    events.push({
      id: block.id,
      kind: "block",
      title: task?.title || block.title,
      domain: block.domain,
      start: block.starts_at,
      end: block.ends_at,
      state: task?.status === "done" ? "done" : "approved",
      taskId: block.task_id,
      version: block.version,
      fixed: block.fixed,
      explanation: "",
      ...place,
    });
  }
  for (const proposal of proposals) {
    if (proposal.status !== "pending" || proposal.kind !== "calendar_block") continue;
    const payload = PlanBoard.payload(proposal);
    const starts = payload.starts_at;
    const ends = payload.ends_at;
    if (typeof starts !== "string" || typeof ends !== "string") continue;
    const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
    const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
    const domain = (task?.domain || payload.domain || "work") as Domain;
    const place = span(starts, ends, timeZone);
    events.push({
      id: proposal.id,
      kind: "proposal",
      title: PlanBoard.titleForProposal(proposal, tasks),
      domain,
      start: starts,
      end: ends,
      state: "proposed",
      taskId,
      version: proposal.version,
      fixed: false,
      explanation: proposal.explanation,
      ...place,
    });
  }
  return events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

export function visibleEvents(events: CalEvent[], filters: ShowFilters, query: string): CalEvent[] {
  const needle = query.trim().toLowerCase();
  return events.filter((event) => {
    if (event.state === "proposed" && !filters.proposals) return false;
    if (!filters[event.domain]) return false;
    if (needle && !event.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function showSummary(filters: ShowFilters): string {
  const domains = (["work", "home", "personal"] as const).filter((domain) => filters[domain]);
  const calendar = domains.length === 3 ? "All calendars" : domains.length === 0 ? "No calendars" : domains.map((domain) => domain[0].toUpperCase() + domain.slice(1)).join(", ");
  return `${calendar} · proposals ${filters.proposals ? "on" : "off"}`;
}

export function withMove(event: CalEvent, start: string, end: string, timeZone: string): CalEvent {
  return { ...event, start, end, ...span(start, end, timeZone) };
}
