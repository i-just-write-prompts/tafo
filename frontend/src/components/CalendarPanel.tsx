import { api, formatWhen } from "../api";
import type { AuditEntry, Availability, CalendarBlock, Meta, OutboxOperation } from "../types";

interface Props {
  meta: Meta;
  blocks: CalendarBlock[];
  operations: OutboxOperation[];
  availability: Availability | null;
  audit: AuditEntry[];
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

function badge(block: CalendarBlock): { text: string; className: string } {
  if (block.written_mode === "demo" && block.status === "cancelled") {
    return { text: "Simulated cancel — not synced", className: "badge sim" };
  }
  if (block.written_mode === "demo" || block.sync_state === "simulated") {
    return { text: "Simulated — not synced to Google", className: "badge sim" };
  }
  if (block.sync_state === "synced" && block.status === "cancelled") {
    return { text: "Cancelled on Google", className: "badge" };
  }
  if (block.sync_state === "synced") {
    return { text: "Synced to Google Calendar", className: "badge good" };
  }
  if (block.sync_state === "partial") {
    return { text: "Partial failure — not fully synced", className: "badge bad" };
  }
  return { text: "Not synced", className: "badge bad" };
}

export function CalendarPanel({ meta, blocks, operations, availability, audit, onRefresh, onError }: Props) {
  return (
    <div className="split">
      <div className="stack">
        <article className="card">
          <h2>App-owned blocks</h2>
          <p className="hint">
            {meta.calendar_mode === "demo"
              ? "Demo mode stores these locally and does not call Google."
              : meta.google_configured
                ? "Live mode writes app-owned blocks through Google Calendar."
                : "Live mode is not configured, so writes fail closed."}
            {" "}
            Work invite: {meta.work_invite_configured ? "configured locally" : "not configured"}.
          </p>
        </article>
        {blocks.length === 0 && <article className="card">No blocks yet. Propose one from a task, then approve it.</article>}
        {blocks.map((block) => {
          const label = badge(block);
          return (
            <article key={block.id} className="card" data-testid="calendar-block">
              <div className="row">
                <h2>{block.title}</h2>
                <span className={label.className} data-testid="sync-label">{label.text}</span>
              </div>
              <p className="meta">
                <span>{formatWhen(block.starts_at, meta.display_timezone)}</span>
                <span>to {formatWhen(block.ends_at, meta.display_timezone)}</span>
                {block.fixed && <span>Fixed</span>}
                <span>{block.domain}</span>
              </p>
              <p>{block.honest_label}</p>
            </article>
          );
        })}
        <article className="card">
          <h2>Outbox</h2>
          {operations.length === 0 && <p className="hint">No calendar operations yet.</p>}
          {operations.map((operation) => (
            <div key={operation.id}>
              <p>
                <strong>{operation.operation}</strong> · {operation.status} · attempt {operation.attempt_count}
              </p>
              <p>{operation.honest_label}</p>
              {operation.result && (
                <ul className="steps">
                  {operation.result.steps.map((step) => (
                    <li key={`${operation.id}-${step.name}`} className={step.ok ? "" : "bad"}>
                      {step.name}: {step.detail}
                    </li>
                  ))}
                </ul>
              )}
              {(operation.status === "failed" || operation.status === "partial" || operation.status === "pending") && (
                <button
                  className="tiny"
                  type="button"
                  onClick={() => {
                    api(`/api/calendar/outbox/${operation.id}/retry`, { method: "POST" })
                      .then(() => onRefresh())
                      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Retry failed"));
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          ))}
        </article>
      </div>
      <aside className="stack">
        <article className="card">
          <h2>Known busy time</h2>
          {!availability && <p className="hint">Busy time has not loaded.</p>}
          {availability && (
            <>
              <p>Source: {availability.read_source}. This view is not conflict-free.</p>
              {availability.read_error && <p className="error-banner">{availability.read_error} Do not treat the calendar as free.</p>}
              <p className="hint">Mirrored app blocks hidden so they are not counted twice: {availability.suppressed_mirrors.length}.</p>
              <p className="hint">App-owned markers without a local row, still treated as busy: {availability.orphan_app_blocks.length}.</p>
              <ul className="steps">
                {availability.external_busy.slice(0, 8).map((item) => (
                  <li key={`${item.summary}-${item.starts_at}`}>
                    {item.summary} · {formatWhen(item.starts_at, meta.display_timezone)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
        <article className="card">
          <h2>Recent decisions</h2>
          <ul className="steps">
            {audit.slice(0, 8).map((entry) => (
              <li key={entry.id}>{entry.action} · {entry.actor}</li>
            ))}
          </ul>
        </article>
      </aside>
    </div>
  );
}
