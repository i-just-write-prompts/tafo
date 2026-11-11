import { PlanBoard } from "./selectors";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function Toolbar() {
  const plan = usePlan();
  const pending = PlanBoard.pendingOnDays(plan.proposals, plan.dayKeys, plan.timeZone);
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button type="button" data-testid="cal-prev" aria-label="Previous" onClick={() => plan.shift(-1)}>←</button>
        <button type="button" data-testid="cal-today" aria-keyshortcuts="T" onClick={plan.goToday}>Today</button>
        <button type="button" data-testid="cal-next" aria-label="Next" onClick={() => plan.shift(1)}>→</button>
      </div>
      <div className="toolbar-group">
        <button type="button" data-testid="cal-week" aria-pressed={plan.mode === "week"} aria-keyshortcuts="W" className={plan.mode === "week" ? "active" : ""} onClick={() => plan.setMode("week")}>Week</button>
        <button type="button" data-testid="cal-day" aria-pressed={plan.mode === "day"} aria-keyshortcuts="D" className={plan.mode === "day" ? "active" : ""} onClick={() => plan.setMode("day")}>Day</button>
      </div>
      <p className="range-label">{PlanTime.rangeLabel(plan.dayKeys, plan.timeZone)}</p>
      <label className="find-label">
        <span className="sr-only">Find tasks and blocks</span>
        <input
          ref={plan.findRef}
          data-testid="quick-find"
          value={plan.find}
          placeholder="Find"
          aria-label="Find tasks and blocks"
          onChange={(event) => plan.setFind(event.target.value)}
        />
      </label>
      {pending.length > 0 && (
        <button type="button" data-testid="approve-all" onClick={plan.approveAll}>
          Approve all ({pending.length})
        </button>
      )}
      <button type="button" data-testid="settings-open" onClick={plan.openSettings}>Settings</button>
      <p className="sr-only">
        Keys: T today, W week, D day, arrows move the range or a focused block, N new task, slash finds, A approves, X denies, space toggles done, escape closes, control Z undoes.
      </p>
    </div>
  );
}
