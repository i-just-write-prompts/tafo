import { Block } from "./Block";
import type { LaidItem } from "./layout";
import { ProposedBlock } from "./ProposedBlock";
import { PlanBoard } from "./selectors";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function DayHeader({ dayKey }: { dayKey: string }) {
  const plan = usePlan();
  const midnight = PlanTime.midnight(dayKey, plan.timeZone);
  const label = PlanTime.formatDay(midnight, plan.timeZone);
  const [weekday, ...rest] = label.split(" ");
  const pending = PlanBoard.pendingOnDays(plan.proposals, [dayKey], plan.timeZone).length;
  const odd = Math.abs(PlanTime.dayMinutes(dayKey, plan.timeZone) - 1440) > 1;
  return (
    <header className="day-head">
      <span className="day-name">{weekday}</span>
      <span className="day-date">{rest.join(" ")}</span>
      {odd && <span className="dst-flag">Clocks change</span>}
      {pending > 0 && (
        <button type="button" data-testid={`approve-day-${dayKey}`} onClick={() => plan.approveDay(dayKey)}>
          Approve day ({pending})
        </button>
      )}
    </header>
  );
}

export function DayColumn({ dayKey, items }: { dayKey: string; items: LaidItem[] }) {
  const plan = usePlan();
  const midnight = PlanTime.midnight(dayKey, plan.timeZone);
  const minutes = PlanTime.dayMinutes(dayKey, plan.timeZone);
  const ticks = PlanTime.hourTicks(dayKey, plan.timeZone);
  const nowMinutes = (plan.now.getTime() - midnight.getTime()) / 60000;
  const showNow = PlanTime.dayKey(plan.now, plan.timeZone) === dayKey && nowMinutes >= 0 && nowMinutes <= minutes;
  const odd = Math.abs(minutes - 1440) > 1;
  return (
    <div
      className="day-col"
      data-day={dayKey}
      data-testid={`cal-column-${dayKey}`}
      style={{ height: PlanTime.dayHeightPx(dayKey, plan.timeZone) }}
    >
      {ticks.map((tick) => (
        <span key={tick.top} className="hour-line" style={{ top: tick.top }} />
      ))}
      {odd && ticks.map((tick) => (
        <span key={`label-${tick.top}`} className="hour-label in-col" style={{ top: tick.top }}>{PlanTime.formatHour(tick.hour)}</span>
      ))}
      {showNow && <span className="now-line" data-testid="now-line" style={{ top: PlanTime.yPx(nowMinutes) }} />}
      {items.map((item) => (
        item.kind === "proposed"
          ? <ProposedBlock key={item.key} item={item} />
          : <Block key={item.key} item={item} />
      ))}
    </div>
  );
}
