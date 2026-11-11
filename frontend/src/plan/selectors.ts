import type { CalendarBlock, Proposal, Task } from "../types";
import { PlanTime } from "./time";

export class PlanBoard {
  static payload(proposal: Proposal): Record<string, unknown> {
    return proposal.edited_payload ?? proposal.payload;
  }

  static matches(title: string, find: string): boolean {
    const query = find.trim().toLowerCase();
    if (!query) return true;
    return title.toLowerCase().includes(query);
  }

  static titleForBlock(block: CalendarBlock, tasks: Task[]): string {
    const task = tasks.find((item) => item.id === block.task_id);
    return task?.title || block.title;
  }

  static titleForProposal(proposal: Proposal, tasks: Task[]): string {
    const payload = PlanBoard.payload(proposal);
    const taskId = payload.task_id;
    const task = typeof taskId === "string" ? tasks.find((item) => item.id === taskId) : undefined;
    if (task) return task.title;
    return typeof payload.title === "string" && payload.title ? payload.title : "Proposed";
  }

  static scheduledTaskIds(blocks: CalendarBlock[], proposals: Proposal[]): Set<string> {
    const ids = new Set<string>();
    for (const block of blocks) {
      if (block.status === "scheduled" && block.task_id) ids.add(block.task_id);
    }
    for (const proposal of proposals) {
      if (proposal.status !== "pending" && proposal.status !== "approved") continue;
      if (proposal.kind !== "calendar_block" && proposal.kind !== "calendar_update") continue;
      const taskId = PlanBoard.payload(proposal).task_id;
      if (typeof taskId === "string" && taskId) ids.add(taskId);
    }
    return ids;
  }

  static sidebarTasks(
    tasks: Task[],
    blocks: CalendarBlock[],
    proposals: Proposal[],
    mode: "all" | "unscheduled",
    find: string,
  ): Task[] {
    const taken = PlanBoard.scheduledTaskIds(blocks, proposals);
    return tasks.filter((task) => {
      if (task.status === "done") return false;
      if (!PlanBoard.matches(task.title, find)) return false;
      if (mode === "unscheduled" && taken.has(task.id)) return false;
      return true;
    });
  }

  static age(createdAt: string | undefined, now: Date): { label: string; tone: "new" | "amber" | "red" } {
    if (!createdAt) return { label: "new", tone: "new" };
    const days = (now.getTime() - new Date(createdAt).getTime()) / 86400000;
    if (Number.isNaN(days)) return { label: "new", tone: "new" };
    if (days >= 7) return { label: `${Math.floor(days)}d`, tone: "red" };
    if (days >= 3) return { label: `${Math.floor(days)}d`, tone: "amber" };
    return { label: "new", tone: "new" };
  }

  static estimateLabel(hours: number | null): string {
    if (hours == null) return "";
    const minutes = Math.round(hours * 60);
    if (minutes < 60) return `${minutes}m`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${hours}h`;
  }

  static pendingOnDays(proposals: Proposal[], dayKeys: string[], timeZone: string): Proposal[] {
    const wanted = new Set(dayKeys);
    return proposals.filter((proposal) => {
      if (proposal.status !== "pending") return false;
      if (proposal.kind !== "calendar_block" && proposal.kind !== "calendar_update" && proposal.kind !== "calendar_cancel") {
        return false;
      }
      const starts = PlanBoard.payload(proposal).starts_at;
      if (typeof starts !== "string") return false;
      const instant = new Date(starts);
      if (Number.isNaN(instant.getTime())) return false;
      return wanted.has(PlanTime.dayKey(instant, timeZone));
    });
  }
}
