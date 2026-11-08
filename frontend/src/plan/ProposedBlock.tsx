import type { LaidItem } from "./layout";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function ProposedBlock({ item }: { item: LaidItem }) {
  const plan = usePlan();
  if (!item.proposalId) return null;
  const id = item.proposalId;
  const provisional = id.startsWith("opt-");
  const busy = plan.busyIds.has(id);
  const range = `${PlanTime.formatTime(item.start, plan.timeZone)}–${PlanTime.formatTime(item.end, plan.timeZone)}`;
  return (
    <div
      className={`block proposed domain-${item.domain}`}
      data-testid={`proposed-${id}`}
      data-proposal-id={id}
      style={{
        top: item.top,
        height: item.height,
        left: `${(item.lane / item.lanes) * 100}%`,
        width: `${100 / item.lanes}%`,
      }}
    >
      <button
        type="button"
        className="block-face"
        title={item.title}
        aria-label={PlanTime.blockLabel(item.title, item.start, item.end, plan.timeZone, true)}
      >
        <span className="block-title">{item.title}</span>
        <span className="block-time">{range}</span>
        <span className="proposed-label">Proposed</span>
      </button>
      <div className="proposal-actions">
        <button type="button" disabled={busy || provisional} onClick={() => plan.approve(id)}>Approve</button>
        <button type="button" disabled={busy || provisional} onClick={() => plan.deny(id)}>Deny</button>
      </div>
    </div>
  );
}
