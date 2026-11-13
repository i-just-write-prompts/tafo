import { useState } from "react";
import { api } from "../api";
import { calendar } from "../calendar/client";
import type { CalendarBlock, Task } from "../types";
import { domainLabel, rangeLabel } from "../v3/format";
import { Sparkle } from "../v3/icons";
import type { CalEvent } from "../v3/model";
import type { HoursPayload } from "./hoursTypes";
import { blockOutsideHours } from "./hours";
import { PlanTime } from "../plan/time";

const DOMAINS = ["work", "home", "personal"] as const;

export function EventDetailsSlice2(props: {
  event: CalEvent;
  block: CalendarBlock | null;
  task: Task | null;
  hours: HoursPayload | null;
  timeZone: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onDecide: (event: CalEvent, action: "approve" | "deny") => void;
  onRetry: (event: CalEvent) => void;
  onTime: () => void;
  onComplete: (title: string, undo: () => Promise<void>) => void;
}) {
  const { event } = props;
  const [title, setTitle] = useState(event.title);
  const [notes, setNotes] = useState(props.task?.notes ?? "");
  const [domain, setDomain] = useState(event.domain);
  const outside = props.hours
    ? blockOutsideHours(props.hours, domain, PlanTime.weekdayIndex(event.dayKey), event.startHour, event.endHour)
    : false;

  async function saveTitle(value: string) {
    if (!props.block || value === props.block.title) return;
    await calendar.move({
      kind: "block",
      title: value,
      startsAt: props.block.starts_at,
      endsAt: props.block.ends_at,
      timeZone: props.timeZone,
      block: { ...props.block, title: value },
    });
    await props.onRefresh();
  }

  async function saveDomain(next: typeof domain) {
    setDomain(next);
    if (!props.block) return;
    await calendar.move({
      kind: "block",
      title: props.block.title,
      startsAt: props.block.starts_at,
      endsAt: props.block.ends_at,
      timeZone: props.timeZone,
      block: { ...props.block, domain: next },
    });
    await props.onRefresh();
  }

  async function saveNotes(value: string) {
    if (!props.task) return;
    await api(`/api/tasks/${props.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expected_version: props.task.version, notes: value }),
    });
    await props.onRefresh();
  }

  async function markDone() {
    if (!props.task || props.task.status === "done") return;
    const previous = props.task.status;
    await api(`/api/tasks/${props.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expected_version: props.task.version, status: "done" }),
    });
    await props.onRefresh();
    props.onComplete(event.title, async () => {
      await api(`/api/tasks/${props.task!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expected_version: props.task!.version + 1, status: previous }),
      });
      await props.onRefresh();
    });
  }

  const complete = props.task?.status === "done" || event.state === "done";

  return (
    <div className="sheet details-slice2" role="dialog" aria-label={event.title} data-testid="event-sheet-slice2">
      <div className="sheet-grip" />
      <div className="details-head">
        {props.task ? (
          <button
            type="button"
            className={complete ? "complete on" : "complete"}
            data-testid="mark-complete"
            aria-label={complete ? "Completed" : "Mark complete"}
            onClick={() => void markDone()}
          />
        ) : <span className="complete-spacer" />}
        <input
          className="title-edit"
          data-testid="event-title"
          role="heading"
          aria-level={2}
          aria-label={title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle(title.trim())}
        />
      </div>
      <p className="sub">
        {event.state === "unplaced"
          ? "Not on calendar"
          : event.state === "proposed"
            ? `Agent suggestion · ${domainLabel(event.domain)}`
            : domainLabel(event.domain)}
      </p>
      {event.state === "proposed" ? (
        <span className={`proposed-chip ${event.domain}`}><Sparkle /> Proposed</span>
      ) : null}
      {event.explanation ? <p className="why">Why: {event.explanation}</p> : null}
      <button type="button" className="time-row" onClick={props.onTime}>
        <span>{event.dayKey}</span>
        <span>{rangeLabel(event.startHour, event.endHour)} ›</span>
      </button>
      <div className="chip-row" data-testid="category-chips">
        {DOMAINS.map((chip) => (
          <button
            key={chip}
            type="button"
            className={domain === chip ? "chip on" : "chip"}
            data-testid={`category-${chip}`}
            onClick={() => void saveDomain(chip)}
          >
            {domainLabel(chip)}
          </button>
        ))}
      </div>
      {outside ? <p className="why outside-hours" data-testid="outside-hours">Outside work hours</p> : null}
      <label className="section-label">Notes</label>
      <textarea
        data-testid="event-notes"
        aria-label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => void saveNotes(notes)}
        rows={3}
      />
      {event.state === "unplaced" ? (
        <button type="button" className="quiet" data-testid="unplaced-retry" onClick={() => props.onRetry(event)}>Retry</button>
      ) : null}
      {event.state === "proposed" ? (
        <div className="pair">
          <button type="button" className="no" onClick={() => props.onDecide(event, "deny")}>Deny</button>
          <button type="button" className="yes" onClick={() => props.onDecide(event, "approve")}>Approve</button>
        </div>
      ) : null}
      <button type="button" className="quiet" onClick={props.onClose}>Close</button>
    </div>
  );
}
