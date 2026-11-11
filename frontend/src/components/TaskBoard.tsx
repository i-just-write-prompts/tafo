import { useState } from "react";
import { api, reportFailure } from "../api";
import { DeleteControl } from "./DeleteControl";
import type { Domain, Meta, Status, Suggestion, Task, View } from "../types";

const STATUSES: Status[] = ["todo", "doing", "waiting", "done"];

interface Props {
  tasks: Task[];
  meta: Meta;
  view: View;
  scope: "today" | "backlog";
  onView: (view: View) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onProposed: () => void;
}

export function TaskBoard({ tasks, meta, view, scope, onView, onRefresh, onError, onProposed }: Props) {
  const [title, setTitle] = useState("");
  const [domain, setDomain] = useState<Domain>("work");
  const [estimate, setEstimate] = useState("");
  const [due, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<{ task: Task; start: string; end: string; invite: boolean } | null>(null);
  const [checkTitle, setCheckTitle] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    try {
      await action();
      await onRefresh();
    } catch (error) {
      await reportFailure(error, onRefresh, onError);
    }
  }

  return (
    <div className="board">
      <div className="stack">
        <div className="filters">
          {(["all", "work", "life"] as View[]).map((item) => (
            <button key={item} className={item === view ? "active" : ""} type="button" onClick={() => onView(item)}>
              {item === "all" ? "All" : item === "work" ? "Work" : "Life"}
            </button>
          ))}
          <span className="hint">{meta.filter_note}</span>
        </div>
        <p className="hint">
          {scope === "today"
            ? "Today is the list you chose to face. Arrows set the order inside this view."
            : "Backlog holds the rest. Move a task onto Today when you want it in front of you."}
        </p>
        {tasks.length === 0 && <article className="card">Nothing in this view yet.</article>}
        {tasks.map((task) => {
          const ratio = task.progress.checklist_total
            ? task.progress.checklist_done / task.progress.checklist_total
            : task.status === "done"
              ? 1
              : 0;
          return (
            <article key={task.id} className={`task ${task.domain} ${task.status === "done" ? "done" : ""}`} data-testid="task-card">
              <div className="task-head">
                <h2 className="title">{task.title}</h2>
                <span className={`badge ${task.domain}`}>{task.domain}</span>
              </div>
              {editingId === task.id ? (
                <form
                  className="form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await api(`/api/tasks/${task.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          expected_version: task.version,
                          title: editTitle,
                          notes: editNotes,
                        }),
                      });
                      setEditingId(null);
                    });
                  }}
                >
                  <label>
                    <span>Title</span>
                    <input data-testid="task-edit-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required />
                  </label>
                  <label>
                    <span>Notes</span>
                    <input data-testid="task-edit-notes" value={editNotes} onChange={(event) => setEditNotes(event.target.value)} />
                  </label>
                  <div className="actions">
                    <button className="primary" type="submit" data-testid="task-edit-save">Save edit</button>
                    <button className="ghost" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="tiny"
                  data-testid="task-edit"
                  onClick={() => {
                    setEditingId(task.id);
                    setEditTitle(task.title);
                    setEditNotes(task.notes);
                  }}
                >
                  Edit title and notes
                </button>
              )}
              <div className="meta">
                <span>{task.estimate_hours ?? "no"}h est</span>
                <span>{task.progress.tracked_hours.toFixed(1)}h tracked</span>
                {task.due_date && <span>due {task.due_date}</span>}
                <span>
                  checklist {task.progress.checklist_done}/{task.progress.checklist_total}
                </span>
              </div>
              <div className="meter" aria-hidden="true"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
              {task.notes && <p className="hint">{task.notes}</p>}
              <div className="stack">
                {task.subtasks.map((item) => (
                  <div key={item.id} className="check">
                    <label>
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={(event) =>
                          void run(() =>
                            api(`/api/subtasks/${item.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ expected_version: item.version, done: event.target.checked }),
                            }).then(() => undefined),
                          )
                        }
                      />
                      {item.title}
                    </label>
                    <DeleteControl
                      label={`checklist item ${item.title}`}
                      pending={pendingDelete === `sub:${item.id}`}
                      onAsk={() => setPendingDelete(`sub:${item.id}`)}
                      onCancel={() => setPendingDelete(null)}
                      onConfirm={() =>
                        void run(async () => {
                          await api(`/api/subtasks/${item.id}?expected_version=${item.version}`, { method: "DELETE" });
                          setPendingDelete(null);
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="actions">
                <select
                  aria-label={`Status for ${task.title}`}
                  value={task.status}
                  onChange={(event) =>
                    void run(() =>
                      api(`/api/tasks/${task.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ expected_version: task.version, status: event.target.value }),
                      }).then(() => undefined),
                    )
                  }
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
                <button type="button" className="tiny" aria-label={`Move ${task.title} up`} onClick={() => void run(() => api(`/api/tasks/${task.id}/move`, { method: "POST", body: JSON.stringify({ direction: "up", view, scope, expected_version: task.version }) }).then(() => undefined))}>Up</button>
                <button type="button" className="tiny" aria-label={`Move ${task.title} down`} onClick={() => void run(() => api(`/api/tasks/${task.id}/move`, { method: "POST", body: JSON.stringify({ direction: "down", view, scope, expected_version: task.version }) }).then(() => undefined))}>Down</button>
                <button
                  type="button"
                  className="tiny"
                  onClick={() =>
                    void run(() =>
                      api(`/api/tasks/${task.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ expected_version: task.version, on_today: !task.on_today }),
                      }).then(() => undefined),
                    )
                  }
                >
                  {task.on_today ? "To backlog" : "To today"}
                </button>
                <button
                  type="button"
                  className="tiny"
                  onClick={() =>
                    void run(async () => {
                      const suggestion = await api<Suggestion>(`/api/calendar/suggestion?task_id=${task.id}`);
                      setDraft({ task, start: suggestion.starts_local, end: suggestion.ends_local, invite: false });
                    })
                  }
                >
                  Propose block
                </button>
                <button type="button" className="tiny" onClick={() => void run(() => api(`/api/tasks/${task.id}/timer/start`, { method: "POST" }).then(() => undefined))}>
                  Start timer
                </button>
                {task.status !== "done" && (
                  <button type="button" className="tiny" onClick={() => void run(() => api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ expected_version: task.version, status: "done" }) }).then(() => undefined))}>
                    Mark done
                  </button>
                )}
                <DeleteControl
                  label={`task ${task.title}`}
                  pending={pendingDelete === `task:${task.id}`}
                  onAsk={() => setPendingDelete(`task:${task.id}`)}
                  onCancel={() => setPendingDelete(null)}
                  onConfirm={() =>
                    void run(async () => {
                      await api(`/api/tasks/${task.id}/delete`, {
                        method: "POST",
                        body: JSON.stringify({ expected_version: task.version }),
                      });
                      setPendingDelete(null);
                    })
                  }
                />
              </div>
              <form
                className="row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = (checkTitle[task.id] || "").trim();
                  if (!value) return;
                  void run(async () => {
                    await api(`/api/tasks/${task.id}/subtasks`, { method: "POST", body: JSON.stringify({ title: value }) });
                    setCheckTitle({ ...checkTitle, [task.id]: "" });
                  });
                }}
              >
                <input
                  aria-label={`Checklist item for ${task.title}`}
                  placeholder="Add a checklist step"
                  value={checkTitle[task.id] || ""}
                  onChange={(event) => setCheckTitle({ ...checkTitle, [task.id]: event.target.value })}
                />
                <button className="tiny" type="submit">Add</button>
              </form>
            </article>
          );
        })}
      </div>
      <aside className="stack composer">
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api("/api/tasks", {
                method: "POST",
                body: JSON.stringify({
                  title,
                  domain,
                  estimate_hours: estimate ? Number(estimate) : null,
                  due_date: due || null,
                  notes,
                  on_today: scope === "today",
                }),
              });
              setTitle("");
              setEstimate("");
              setDue("");
              setNotes("");
            });
          }}
        >
          <h2>Add a task</h2>
          <label>
            <span>Title</span>
            <input data-testid="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            <span>Domain</span>
            <select data-testid="task-domain" value={domain} onChange={(event) => setDomain(event.target.value as Domain)}>
              <option value="work">Work</option>
              <option value="home">Home</option>
              <option value="personal">Personal</option>
            </select>
          </label>
          <label>
            <span>Estimate hours</span>
            <input data-testid="task-estimate" type="number" min="0.25" step="0.25" value={estimate} onChange={(event) => setEstimate(event.target.value)} />
          </label>
          <label>
            <span>Due date</span>
            <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <label>
            <span>Notes</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <button className="primary" type="submit">Add task</button>
        </form>
        {draft && (
          <form
            className="card form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api("/api/hermes/proposals", {
                  method: "POST",
                  body: JSON.stringify({
                    source: "tafo-ui",
                    source_kind: "human",
                    kind: "calendar_block",
                    explanation: `Hold time for “${draft.task.title}”. The event title stays generic unless you edit the proposal.`,
                    payload: {
                      task_id: draft.task.id,
                      domain: draft.task.domain,
                      starts_local: draft.start,
                      ends_local: draft.end,
                      timezone: meta.display_timezone,
                      invite_work_email: draft.invite,
                    },
                  }),
                });
                setDraft(null);
                onProposed();
              });
            }}
          >
            <h2>Propose a block</h2>
            <p className="hint">Times use {meta.display_timezone}. Nothing is written until you approve it.</p>
            <p>{meta.outlook_gap}</p>
            <label>
              <span>Start</span>
              <input type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} required />
            </label>
            <label>
              <span>End</span>
              <input type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} required />
            </label>
            {draft.task.domain === "work" && (
              <label className="check">
                <input type="checkbox" checked={draft.invite} onChange={(event) => setDraft({ ...draft, invite: event.target.checked })} />
                Invite the configured work address
              </label>
            )}
            <button className="primary" type="submit">Submit proposal</button>
            <button className="ghost" type="button" onClick={() => setDraft(null)}>Close</button>
          </form>
        )}
      </aside>
    </div>
  );
}
