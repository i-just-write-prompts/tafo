import { PX_PER_MINUTE, PlanTime } from "./time";
import type { LaidItem } from "./layout";
import { PlanActions } from "./actions";
import { usePlan } from "./store";

export function Block({ item }: { item: LaidItem }) {
  const plan = usePlan();
  const block = plan.blocks.find((entry) => entry.id === item.blockId);
  if (!block || !item.blockId) return null;
  const provisional = block.id.startsWith("opt-");
  const range = `${PlanTime.formatTime(item.start, plan.timeZone)}–${PlanTime.formatTime(item.end, plan.timeZone)}`;
  return (
    <div
      className={`block domain-${item.domain}${item.fixed ? " is-fixed" : ""}${item.done ? " is-done" : ""}${item.ghost ? " is-ghost" : ""}`}
      data-testid={`cal-block-${block.id}`}
      data-block-id={block.id}
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
        aria-label={PlanTime.blockLabel(item.title, item.start, item.end, plan.timeZone, false)}
        onPointerDown={(event) => {
          if (event.button !== 0 || provisional) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const column = event.currentTarget.closest<HTMLElement>("[data-day]");
          if (!column?.dataset.day) return;
          const rect = column.getBoundingClientRect();
          const pointerMin = (event.clientY - rect.top) / PX_PER_MINUTE;
          const startMin = (item.start.getTime() - PlanTime.midnight(column.dataset.day, plan.timeZone).getTime()) / 60000;
          plan.beginDrag({
            kind: "move",
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            key: PlanActions.gestureKey("plan.move"),
            blockId: block.id,
            durationMin: (item.end.getTime() - item.start.getTime()) / 60000,
            grabMin: pointerMin - startMin,
          });
        }}
        onClick={() => {
          if (plan.takeClick()) return;
          plan.openPopover(block.id);
        }}
      >
        <span className="block-title">{item.title}</span>
        <span className="block-time">{range}</span>
        {item.ghost && <span className="was-label">Was</span>}
      </button>
      <input
        className="block-done"
        type="checkbox"
        checked={item.done}
        aria-label={`Mark ${item.title} done`}
        disabled={provisional || !block.task_id}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={() => plan.toggleDone(block.id)}
      />
      {!provisional && (
        <button
          type="button"
          className="resize-handle"
          aria-label={`Resize ${item.title}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            plan.beginDrag({
              kind: "resize",
              pointerId: event.pointerId,
              originX: event.clientX,
              originY: event.clientY,
              x: event.clientX,
              y: event.clientY,
              moved: false,
              key: PlanActions.gestureKey("plan.resize"),
              blockId: block.id,
              durationMin: (item.end.getTime() - item.start.getTime()) / 60000,
              grabMin: 0,
            });
          }}
        />
      )}
    </div>
  );
}
