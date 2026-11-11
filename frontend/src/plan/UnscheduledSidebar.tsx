import { useState } from "react";
import { PlanActions } from "./actions";
import { PlanBoard } from "./selectors";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function UnscheduledSidebar() {
  const plan = usePlan();
  const [title, setTitle] = useState("");
  const [estimate, setEstimate] = useState("");
  const rows = PlanBoard.sidebarTasks(plan.tasks, plan.blocks, plan.proposals, plan.sidebarMode, plan.find);
  return (
    <aside className="sidebar" aria-label="Unscheduled">
      <div className="sidebar-head">
        <h2>Unscheduled</h2>
        <div className="filters" role="group" aria-label="Task filter">
          <button type="button" className={plan.sidebarMode === "all" ? "active" : ""} onClick={() => plan.setSidebarMode("all")}>All</button>
          <button type="button" className={plan.sidebarMode === "unscheduled" ? "active" : ""} onClick={() => plan.setSidebarMode("unscheduled")}>Unscheduled</button>
        </div>
      </div>
      <form
        className="quick-add"
        data-testid="quick-add"
        onSubmit={(event) => {
          event.preventDefault();
          void plan.addTask(title, estimate).then(() => {
            setTitle("");
            setEstimate("");
          }).catch(() => undefined);
        }}
      >
        <input
          ref={plan.quickAddRef}
          aria-label="New task title"
          placeholder="Add a task"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <input
          aria-label="Estimate hours"
          placeholder="Hours"
          inputMode="decimal"
          value={estimate}
          onChange={(event) => setEstimate(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>
      <div className="sidebar-list">
        {rows.length === 0 && <p className="hint">Nothing waiting in this list.</p>}
        {rows.map((task) => {
          const age = PlanBoard.age(task.created_at, plan.now);
          return (
            <div
              key={task.id}
              className="side-task"
              data-testid={`sidebar-task-${task.id}`}
              title={task.title}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                plan.beginDrag({
                  kind: "schedule",
                  pointerId: event.pointerId,
                  originX: event.clientX,
                  originY: event.clientY,
                  x: event.clientX,
                  y: event.clientY,
                  moved: false,
                  key: PlanActions.gestureKey("plan.block"),
                  taskId: task.id,
                  durationMin: PlanTime.minutesFromEstimate(task.estimate_hours),
                  grabMin: 0,
                });
              }}
            >
              <span className={`dot domain-${task.domain}`} aria-hidden="true" />
              <span className="side-title">{task.title}</span>
              <span className="side-estimate">{PlanBoard.estimateLabel(task.estimate_hours)}</span>
              <span className={`age age-${age.tone}`}>{age.label}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
