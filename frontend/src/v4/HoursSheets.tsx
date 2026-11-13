import { useState } from "react";
import { api } from "../api";
import type { HoursPayload, SacredWindow } from "./hoursTypes";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function HoursMenuRow(props: { summary: string; onOpen: () => void }) {
  return (
    <button type="button" role="menuitem" className="tall" data-testid="hours-menu-row" onClick={props.onOpen}>
      <span>Hours &amp; sacred time<small>{props.summary}</small></span>
    </button>
  );
}

export function HoursSheet(props: { payload: HoursPayload; onClose: () => void; onChanged: (next: HoursPayload) => void }) {
  const [editing, setEditing] = useState<SacredWindow | null>(null);
  return (
    <div className="sheet" role="dialog" aria-label="Hours and sacred time" data-testid="hours-sheet">
      <div className="sheet-grip" />
      <h2>Hours &amp; sacred time</h2>
      <p className="section-label">CATEGORY HOURS</p>
      {(["work", "home", "personal"] as const).map((domain) => (
        <div key={domain} className="row">
          <strong style={{ textTransform: "capitalize" }}>{domain}</strong>
          <small style={{ display: "block", color: "var(--t2)" }}>
            {props.payload.category_hours.filter((row) => row.domain === domain).length} spans saved
          </small>
        </div>
      ))}
      <p className="section-label">SACRED WINDOWS</p>
      {props.payload.sacred_windows.map((window) => (
        <button key={window.id} type="button" className="row" data-testid={`sacred-row-${window.id}`} onClick={() => setEditing(window)}>
          {window.name}
          <small style={{ marginLeft: "auto", color: "var(--t2)" }}>{formatRange(window)}</small>
        </button>
      ))}
      <button type="button" className="quiet" data-testid="add-sacred" onClick={() => setEditing(emptySacred())}>Add sacred time</button>
      <p className="why">Coming week: the agent only proposes. Nothing moves into sacred time without your OK.</p>
      <button type="button" className="quiet" onClick={props.onClose}>Close</button>
      {editing ? (
        <SacredEditor
          window={editing}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const next = await api<{ window: SacredWindow } & HoursPayload>("/api/hours/sacred", {
              method: "POST",
              body: JSON.stringify(body),
            });
            props.onChanged(next);
            setEditing(null);
          }}
          onDelete={async (id) => {
            const next = await api<HoursPayload>(`/api/hours/sacred/${id}`, { method: "DELETE" });
            props.onChanged(next);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SacredEditor(props: {
  window: SacredWindow;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.window.name);
  const [days, setDays] = useState(props.window.days_mask);
  const [start, setStart] = useState(props.window.start_minutes);
  const [end, setEnd] = useState(props.window.end_minutes);
  const [agentBlock, setAgentBlock] = useState(props.window.agent_block === 1);
  const [headsUp, setHeadsUp] = useState(props.window.heads_up === 1);
  return (
    <div className="sheet sacred-edit" role="dialog" aria-label="Edit sacred time" data-testid="sacred-edit-sheet">
      <div className="sheet-grip" />
      <h2>Edit sacred time</h2>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="day-toggles" data-testid="sacred-day-toggles">
        {DAYS.map((label, index) => (
          <button
            key={label + index}
            type="button"
            className={(days & (1 << index)) !== 0 ? "day on" : "day"}
            aria-label={label}
            onClick={() => setDays((days & (1 << index)) !== 0 ? days & ~(1 << index) : days | (1 << index))}
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        Starts
        <input type="number" value={start} onChange={(e) => setStart(Number(e.target.value))} />
      </label>
      <label>
        Ends
        <input type="number" value={end} onChange={(e) => setEnd(Number(e.target.value))} />
      </label>
      <label className="row">
        <input type="checkbox" checked={agentBlock} onChange={(e) => setAgentBlock(e.target.checked)} />
        Keep the agent out
      </label>
      <label className="row">
        <input type="checkbox" checked={headsUp} onChange={(e) => setHeadsUp(e.target.checked)} />
        Heads-up when I move work here
      </label>
      <button
        type="button"
        className="primary"
        onClick={() => props.onSave({
          id: props.window.id,
          name,
          days_mask: days,
          start_minutes: start,
          end_minutes: end,
          agent_block: agentBlock,
          heads_up: headsUp,
        })}
      >
        Save
      </button>
      {props.window.id ? (
        <button type="button" className="danger" data-testid="delete-sacred" onClick={() => props.onDelete(props.window.id)}>Delete sacred time</button>
      ) : null}
      <button type="button" className="quiet" onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

function emptySacred(): SacredWindow {
  return {
    id: "",
    name: "New window",
    days_mask: 127,
    start_minutes: 18 * 60,
    end_minutes: 19 * 60,
    agent_block: 1,
    heads_up: 1,
    version: 1,
  };
}

function formatRange(window: SacredWindow): string {
  const start = minutesLabel(window.start_minutes);
  const end = minutesLabel(window.end_minutes);
  return `${start}–${end}`;
}

function minutesLabel(total: number): string {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const shown = hour % 12 || 12;
  return minute ? `${shown}:${String(minute).padStart(2, "0")} ${suffix}` : `${shown} ${suffix}`;
}
