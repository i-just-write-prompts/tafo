import { DayColumn, DayHeader } from "./DayColumn";
import { PlanLayout } from "./layout";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function CalendarGrid() {
  const plan = usePlan();
  const placed = PlanLayout.place({
    dayKeys: plan.dayKeys,
    timeZone: plan.timeZone,
    blocks: plan.blocks,
    proposals: plan.proposals,
    tasks: plan.tasks,
    find: plan.find,
  });
  const ticks = plan.dayKeys.length > 0 ? PlanTime.hourTicks(plan.dayKeys[0], plan.timeZone) : [];
  const any = [...placed.byDay.values()].some((items) => items.length > 0);
  const headerColumns = `52px repeat(${plan.dayKeys.length}, minmax(0, 1fr))`;
  return (
    <div className="cal-frame">
      <div className="cal-head" style={{ gridTemplateColumns: headerColumns }}>
        <div />
        {plan.dayKeys.map((dayKey) => <DayHeader key={dayKey} dayKey={dayKey} />)}
      </div>
      <div className="cal-scroll" ref={plan.scrollerRef}>
        <div className="cal-grid" data-testid="cal-grid" style={{ height: placed.height }}>
          <div className="hour-gutter" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.top} className="hour-label" style={{ top: tick.top }}>{PlanTime.formatHour(tick.hour)}</span>
            ))}
          </div>
          <div className="cols" style={{ height: placed.height, gridTemplateColumns: `repeat(${plan.dayKeys.length}, minmax(0, 1fr))` }}>
            {plan.dayKeys.map((dayKey) => (
              <DayColumn key={dayKey} dayKey={dayKey} items={placed.byDay.get(dayKey) ?? []} />
            ))}
            <svg className="connectors" viewBox={`0 0 1000 ${placed.height || 1}`} preserveAspectRatio="none" aria-hidden="true">
              {placed.links.map((link) => (
                <line key={link.id} x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} />
              ))}
            </svg>
            {!any && (
              <p className="empty-hint" data-testid="cal-empty">
                {plan.find.trim() ? "Nothing matches that find." : "Drag tasks from the sidebar onto the calendar."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlanSkeleton() {
  return (
    <div className="plan-skeleton" data-testid="cal-skeleton" aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => <div key={index} className="skeleton-col" />)}
    </div>
  );
}
