import { useEffect, useState } from "react";
import { DeleteControl } from "../components/DeleteControl";
import { PlanBoard } from "./selectors";
import { usePlan } from "./store";
import { PlanTime } from "./time";

export function BlockPopover() {
  const plan = usePlan();
  const block = plan.blocks.find((item) => item.id === plan.popoverBlockId);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(30);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!block) return;
    const start = new Date(block.starts_at);
    const end = new Date(block.ends_at);
    const part = PlanTime.parts(start, plan.timeZone);
    setDay(PlanTime.dayKey(start, plan.timeZone));
    setTime(`${String(part.hour).padStart(2, "0")}:${String(part.minute).padStart(2, "0")}`);
    setDuration(Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000)));
    setConfirming(false);
  }, [block?.id, block?.starts_at, block?.ends_at, plan.timeZone]);
  if (!block || block.id.startsWith("opt-")) return null;
  const task = plan.tasks.find((item) => item.id === block.task_id);
  const title = PlanBoard.titleForBlock(block, plan.tasks);
  const start = new Date(block.starts_at);
  return (
    <div className="scrim" onMouseDown={plan.closePopover}>
      <div
        className="popover"
        role="dialog"
        aria-label="Block details"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row">
          <h2>{title}</h2>
          <button type="button" className="ghost" onClick={plan.closePopover}>Close</button>
        </div>
        <p className="meta">
          <span>{PlanTime.formatDay(start, plan.timeZone)}</span>
          <span>{PlanTime.formatTime(start, plan.timeZone)}–{PlanTime.formatTime(new Date(block.ends_at), plan.timeZone)}</span>
          <span>UTC{PlanTime.offsetLabel(start, plan.timeZone)}</span>
        </p>
        <p className="hint">{task ? `Task: ${task.title}` : "No linked task"}</p>
        {block.fixed && <p className="hint">This appointment is fixed. Changing the time asks you to confirm.</p>}
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            plan.saveTimes(block.id, day, time, duration);
          }}
        >
          <label>
            <span>Date</span>
            <input type="date" value={day} onChange={(event) => setDay(event.target.value)} required />
          </label>
          <label>
            <span>Start ({plan.timeZone})</span>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
          </label>
          <label>
            <span>Duration (minutes)</span>
            <input
              type="number"
              min={15}
              max={720}
              step={15}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              required
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={task?.status === "done"}
              disabled={!task}
              onChange={() => plan.toggleDone(block.id)}
            />
            Done
          </label>
          <div className="actions">
            <button className="primary" type="submit">Save time</button>
            <DeleteControl
              label={`block ${title}`}
              pending={confirming}
              onAsk={() => setConfirming(true)}
              onCancel={() => setConfirming(false)}
              onConfirm={() => plan.removeBlock(block.id)}
            />
          </div>
        </form>
      </div>
    </div>
  );
}
