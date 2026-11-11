import { describe, expect, it } from "vitest";
import type { Proposal, Task } from "../types";
import { PlanBoard } from "./selectors";

function proposal(id: string, starts: string, dayKind = "calendar_block"): Proposal {
  return {
    id,
    source: "sample-agent",
    source_kind: "agent",
    kind: dayKind,
    status: "pending",
    explanation: id,
    payload: { starts_at: starts, ends_at: starts, title: id, task_id: id },
    edited_payload: null,
    availability: null,
    version: 1,
  };
}

describe("plan board selectors", () => {
  it("ages tasks at 3 and 7 days", () => {
    const now = new Date("2026-11-07T16:00:00Z");
    expect(PlanBoard.age("2026-11-07T15:00:00Z", now).tone).toBe("new");
    expect(PlanBoard.age("2026-11-04T16:00:00Z", now)).toMatchObject({ tone: "amber", label: "3d" });
    expect(PlanBoard.age("2026-10-31T16:00:00Z", now)).toMatchObject({ tone: "red", label: "7d" });
  });

  it("counts exactly the pending proposals that start on the named days", () => {
    const tuesday = proposal("a", "2026-11-10T15:00:00Z");
    const later = proposal("b", "2026-11-10T18:00:00Z", "calendar_update");
    const wednesday = proposal("c", "2026-11-11T15:00:00Z");
    const rejected = { ...proposal("d", "2026-11-10T15:00:00Z"), status: "rejected" };
    const all = PlanBoard.pendingOnDays([tuesday, later, wednesday, rejected], ["2026-11-10"], "America/Indianapolis");
    expect(all.map((item) => item.id)).toEqual(["a", "b"]);
    const week = PlanBoard.pendingOnDays([tuesday, later, wednesday, rejected], ["2026-11-09", "2026-11-10", "2026-11-11"], "America/Indianapolis");
    expect(week.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("drops a task from unscheduled once it has a block or a pending proposal", () => {
    const tasks = [
      { id: "open", title: "Open", status: "todo", domain: "home" },
      { id: "held", title: "Held", status: "todo", domain: "personal" },
      { id: "done", title: "Done", status: "done", domain: "personal" },
    ] as Task[];
    const proposals = [proposal("p", "2026-11-10T15:00:00Z")];
    proposals[0].payload.task_id = "held";
    const rows = PlanBoard.sidebarTasks(tasks, [], proposals, "unscheduled", "");
    expect(rows.map((task) => task.id)).toEqual(["open"]);
    expect(PlanBoard.sidebarTasks(tasks, [], proposals, "all", "hel").map((task) => task.id)).toEqual(["held"]);
    const approved = [proposal("placed", "2026-11-10T15:00:00Z")];
    approved[0].status = "approved";
    approved[0].payload.task_id = "held";
    expect(PlanBoard.sidebarTasks(tasks, [], approved, "unscheduled", "").map((task) => task.id)).toEqual(["open"]);
  });
});
