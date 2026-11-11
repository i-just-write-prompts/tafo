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
  state: "approved" | "proposed" | "done" | "unplaced";
  taskId: string | null;
  version: number;
  fixed: boolean;
  explanation: string;
  dayKey: string;
  startHour: number;
  endHour: number;
  /** Set when the event is an approved proposal whose calendar write did not land. */
  outboxId?: string | null;
}

/** Newest first, the same order as GET /api/calendar/outbox. */
export interface OutboxSnapshot {
  id: string;
  proposal_id: string;
  status: string;
  operation: string;
  event_key: string;
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

function proposalSpan(proposal: Proposal): { starts: string; ends: string; taskId: string | null; domain: Domain } | null {
  const payload = proposal.edited_payload ?? proposal.payload;
  const starts = payload.starts_at;
  const ends = payload.ends_at;
  if (typeof starts !== "string" || typeof ends !== "string") return null;
  const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
  const domain = (payload.domain || "work") as Domain;
  return { starts, ends, taskId, domain };
}

function scheduledFor(blocks: CalendarBlock[], proposalId: string, eventKey: string): boolean {
  return blocks.some((block) => {
    if (block.status !== "scheduled") return false;
    if (eventKey && block.id === eventKey) return true;
    return Boolean(proposalId) && block.origin_proposal_id === proposalId;
  });
}

export function buildEvents(
  tasks: Task[],
  blocks: CalendarBlock[],
  proposals: Proposal[],
  timeZone: string,
  outbox: OutboxSnapshot[] = [],
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
    if (proposal.kind !== "calendar_block") continue;
    const placeSource = proposalSpan(proposal);
    if (!placeSource) continue;
    const task = placeSource.taskId ? tasks.find((item) => item.id === placeSource.taskId) : undefined;
    const domain = (task?.domain || placeSource.domain) as Domain;
    const place = span(placeSource.starts, placeSource.ends, timeZone);
    if (proposal.status === "pending") {
      events.push({
        id: proposal.id,
        kind: "proposal",
        title: PlanBoard.titleForProposal(proposal, tasks),
        domain,
        start: placeSource.starts,
        end: placeSource.ends,
        state: "proposed",
        taskId: placeSource.taskId,
        version: proposal.version,
        fixed: false,
        explanation: proposal.explanation,
        ...place,
      });
      continue;
    }
    if (proposal.status !== "approved") continue;
    const latest = outbox.find((item) => item.proposal_id === proposal.id);
    if (!latest || (latest.status !== "failed" && latest.status !== "partial")) continue;
    if (scheduledFor(blocks, proposal.id, latest.event_key)) continue;
    events.push({
      id: proposal.id,
      kind: "proposal",
      title: PlanBoard.titleForProposal(proposal, tasks),
      domain,
      start: placeSource.starts,
      end: placeSource.ends,
      state: "unplaced",
      taskId: placeSource.taskId,
      version: proposal.version,
      fixed: false,
      explanation: proposal.explanation,
      outboxId: latest.id,
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
