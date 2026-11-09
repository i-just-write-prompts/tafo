import { useEffect, useRef, useState } from "react";
import { OFFLINE_MESSAGE, api, formatWhen } from "./api";
import { CalendarPanel } from "./components/CalendarPanel";
import { Inbox } from "./components/Inbox";
import { TaskBoard } from "./components/TaskBoard";
import { WeekPanel } from "./components/WeekPanel";
import { PlanSkeleton } from "./plan/CalendarGrid";
import { PlanView } from "./plan/PlanView";
import { SyncStatus } from "./plan/sync";
import { TAFO_REV } from "./rev";
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
      <circle cx="32" cy="32" r="22" fill="#1c1c21" />
      <circle cx="32" cy="32" r="14" fill="none" stroke="#eceae4" strokeWidth="2" />
      <path d="M32 16 L36 32 L32 48 L28 32 Z" fill="#e6b15a" />
      <circle cx="32" cy="32" r="2.5" fill="#eceae4" />
    </svg>
  );
}

function OfflinePanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="offline-panel" role="alert" data-testid="offline-banner">
      <h2>Offline</h2>
      <p>{OFFLINE_MESSAGE}</p>
      <button type="button" data-testid="retry-load" onClick={onRetry}>Retry</button>
    </div>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<Tab>("plan");
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
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  function raise(message: string) {
    setError(message);
    setOffline(message === OFFLINE_MESSAGE);
  }

  async function refresh() {
    const scope = tab === "backlog" ? "backlog" : tab === "today" ? "today" : "all";
    try {
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
      setError(null);
      setOffline(false);
    } catch (reason) {
      raise(reason instanceof Error ? reason.message : "Could not load TAFO");
      throw reason;
    }
  }

  refreshRef.current = refresh;

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [tab, view]);

  useEffect(() => {
    if (tab !== "plan" || offline) return undefined;
    const timer = window.setInterval(() => {
      refreshRef.current().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [tab, offline]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const pending = proposals.filter((item) => item.status === "pending").length;
  const elapsed = active ? Math.max(0, Math.round((now - new Date(active.started_at).getTime()) / 1000)) : 0;
  const chip = SyncStatus.label({
    offline,
    calendarMode: meta?.calendar_mode ?? "demo",
    operations,
  });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Compass />
          <h1>TAFO</h1>
          <p>Task around & find out</p>
        </div>
        <nav className="tabs" aria-label="Sections">
          {([
            ["plan", "Plan"],
            ["today", "Today"],
            ["backlog", "Backlog"],
            ["inbox", `Inbox (${pending})`],
            ["calendar", "Calendar"],
            ["week", "Week"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "tab active" : "tab"}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                if (id === tab) {
                  refresh().catch(() => undefined);
                  return;
                }
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="pills">
          {meta && <span className="pill">{meta.display_timezone}</span>}
          {meta && <span hidden data-testid="mode-banner">{meta.sync_label}</span>}
          <span className={offline ? "pill pill-offline" : meta?.calendar_mode === "demo" ? "pill pill-demo" : "pill pill-live"} data-testid="sync-chip" title={meta?.sync_label ?? ""}>
            {chip}
          </span>
        </div>
      </header>
      {meta?.preview && (
        <p className="preview-banner" role="status" data-testid="preview-banner">
          {meta.preview_banner || "Preview. Demo data only. This copy resets when the server restarts and is not synced to Google."}
        </p>
      )}
      {meta && (
        <p className="gap-banner" data-testid="outlook-gap" title={meta.outlook_gap}>
          <strong>Not conflict-free. </strong>
          {meta.outlook_gap}
        </p>
      )}
      <div className="workspace">
        {offline ? (
          <OfflinePanel onRetry={() => { refresh().catch(() => undefined); }} />
        ) : (
          <>
            {error && (
              <div className="error-banner" role="alert" data-testid="app-error">
                <p>{error}</p>
              </div>
            )}
            {tab === "plan" && !meta && <PlanSkeleton />}
            {meta && tab === "plan" && (
              <PlanView
                meta={meta}
                tasks={tasks}
                blocks={blocks}
                proposals={proposals}
                onRefresh={refresh}
                onError={raise}
              />
            )}
            {meta && (tab === "today" || tab === "backlog") && (
              <div className="tab-scroll">
                <TaskBoard
                  tasks={tasks}
                  meta={meta}
                  view={view}
                  scope={tab}
                  onView={setView}
                  onRefresh={refresh}
                  onError={raise}
                  onProposed={() => setTab("inbox")}
                />
              </div>
            )}
            {meta && tab === "inbox" && (
              <div className="tab-scroll">
                <Inbox proposals={proposals} tasks={tasks} meta={meta} onRefresh={refresh} onError={raise} onApproved={() => setTab("calendar")} />
              </div>
            )}
            {meta && tab === "calendar" && (
              <div className="tab-scroll">
                <CalendarPanel
                  meta={meta}
                  blocks={blocks}
                  operations={operations}
                  availability={availability}
                  audit={audit}
                  onRefresh={refresh}
                  onError={raise}
                />
              </div>
            )}
            {tab === "week" && (
              <div className="tab-scroll">
                <WeekPanel week={week} onRefresh={refresh} onError={raise} />
              </div>
            )}
          </>
        )}
      </div>
      <footer className="footer" data-rev={TAFO_REV}>
        <span className="rev" data-testid="build-rev">{TAFO_REV}</span>
        {meta && <p className="footer-note">{meta.notices[0]}</p>}
        {meta && (
          <details>
            <summary>Privacy notes</summary>
            {meta.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </details>
        )}
      </footer>
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
                .catch((reason: unknown) => raise(reason instanceof Error ? reason.message : "Could not stop"));
            }}
          >
            Stop timer
          </button>
        </div>
      )}
    </div>
  );
}
