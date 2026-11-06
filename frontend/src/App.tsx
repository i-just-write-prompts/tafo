import { useEffect, useState } from "react";
import { api, formatWhen } from "./api";
import { CalendarPanel } from "./components/CalendarPanel";
import { Inbox } from "./components/Inbox";
import { TaskBoard } from "./components/TaskBoard";
import { WeekPanel } from "./components/WeekPanel";
import type {
  AuditEntry,
  Availability,
  CalendarBlock,
  Meta,
  OutboxOperation,
  Proposal,
  Tab,
  Task,
  TimerSession,
  View,
  WeekSummary,
} from "./types";

function Compass() {
  return (
    <svg className="compass" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="22" fill="#1f4a3a" />
      <circle cx="32" cy="32" r="14" fill="none" stroke="#f4efe4" strokeWidth="2" />
      <path d="M32 16 L36 32 L32 48 L28 32 Z" fill="#e4b15c" />
      <circle cx="32" cy="32" r="2.5" fill="#f4efe4" />
    </svg>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [view, setView] = useState<View>("all");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [operations, setOperations] = useState<OutboxOperation[]>([]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [week, setWeek] = useState<WeekSummary | null>(null);
  const [active, setActive] = useState<TimerSession | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  async function refresh() {
    const scope = tab === "backlog" ? "backlog" : tab === "today" ? "today" : "all";
    const [nextMeta, taskBody, proposalBody, timerBody, blockBody, outboxBody, weekBody, auditBody, busyBody] = await Promise.all([
      api<Meta>("/api/meta"),
      api<{ tasks: Task[] }>(`/api/tasks?view=${view}&scope=${scope}`),
      api<{ proposals: Proposal[] }>("/api/hermes/proposals"),
      api<{ active: TimerSession | null }>("/api/timers/active"),
      api<{ blocks: CalendarBlock[] }>("/api/calendar/blocks"),
      api<{ operations: OutboxOperation[] }>("/api/calendar/outbox"),
      api<WeekSummary>("/api/week"),
      api<{ entries: AuditEntry[] }>("/api/audit?limit=8"),
      api<Availability>("/api/calendar/availability"),
    ]);
    setMeta(nextMeta);
    setTasks(taskBody.tasks);
    setProposals(proposalBody.proposals);
    setActive(timerBody.active);
    setBlocks(blockBody.blocks);
    setOperations(outboxBody.operations);
    setWeek(weekBody);
    setAudit(auditBody.entries);
    setAvailability(busyBody);
  }

  useEffect(() => {
    refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load TAFO"));
  }, [tab, view]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const pending = proposals.filter((item) => item.status === "pending").length;
  const elapsed = active ? Math.max(0, Math.round((now - new Date(active.started_at).getTime()) / 1000)) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Compass />
          <div>
            <h1>TAFO</h1>
            <p>Task around & find out</p>
          </div>
        </div>
        {meta && (
          <div className="pills">
            <span className="pill">{meta.display_timezone}</span>
            <span className={meta.calendar_mode === "demo" ? "pill pill-demo" : "pill pill-live"} data-testid="mode-banner">
              {meta.sync_label}
            </span>
          </div>
        )}
      </header>
      {meta && (
        <p className="gap-banner" data-testid="outlook-gap">
          <strong>Not conflict-free. </strong>
          {meta.outlook_gap}
        </p>
      )}
      {error && <p className="error-banner" role="alert">{error}</p>}
      <nav className="tabs">
        {([
          ["today", "Today"],
          ["backlog", "Backlog"],
          ["inbox", `Inbox (${pending})`],
          ["calendar", "Calendar"],
          ["week", "Week"],
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "tab active" : "tab"} type="button" onClick={() => { setError(null); setTab(id); }}>
            {label}
          </button>
        ))}
      </nav>
      {meta && (tab === "today" || tab === "backlog") && (
        <TaskBoard
          tasks={tasks}
          meta={meta}
          view={view}
          scope={tab}
          onView={setView}
          onRefresh={refresh}
          onError={setError}
          onProposed={() => setTab("inbox")}
        />
      )}
      {meta && tab === "inbox" && (
        <Inbox proposals={proposals} meta={meta} onRefresh={refresh} onError={setError} onApproved={() => setTab("calendar")} />
      )}
      {meta && tab === "calendar" && (
        <CalendarPanel
          meta={meta}
          blocks={blocks}
          operations={operations}
          availability={availability}
          audit={audit}
          onRefresh={refresh}
          onError={setError}
        />
      )}
      {tab === "week" && <WeekPanel week={week} onRefresh={refresh} onError={setError} />}
      {meta && (
        <footer className="footer">
          <p>{meta.notices[0]} {meta.notices[1]}</p>
          <details>
            <summary>Privacy notes</summary>
            {meta.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </details>
        </footer>
      )}
      {active && meta && (
        <div className="timerbar">
          <div>
            <strong>{active.task_title}</strong>
            <div>{Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, "0")}s · started {formatWhen(active.started_at, meta.display_timezone)}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              api(`/api/tasks/${active.task_id}/timer/stop`, { method: "POST" })
                .then(() => refresh())
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not stop"));
            }}
          >
            Stop timer
          </button>
        </div>
      )}
    </div>
  );
}
