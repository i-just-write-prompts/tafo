import { api } from "../api";
import type { CalendarBlock, Proposal, Task } from "../types";

export interface DecisionResult {
  proposal: Proposal;
  outbox: { status?: string; honest_label?: string } | null;
  block: CalendarBlock | null;
  idempotent_replay: boolean;
}

export class PlanActions {
  static gestureKey(prefix: string): string {
    const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "");
    return `${prefix}.${cleaned}`.slice(0, 120);
  }

  static propose(body: Record<string, unknown>): Promise<Proposal> {
    return api<Proposal>("/api/hermes/proposals", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  static approve(proposal: Proposal, acknowledgeFixed = false): Promise<DecisionResult> {
    return api<DecisionResult>(`/api/decisions/${proposal.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: proposal.version,
        confirmed: true,
        acknowledge_fixed_move: acknowledgeFixed,
      }),
    });
  }

  static reject(proposal: Proposal, note: string): Promise<Proposal> {
    return api<Proposal>(`/api/decisions/${proposal.id}/reject`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: proposal.version,
        confirmed: true,
        note,
      }),
    });
  }

  static schedule(input: {
    task: Task;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    key: string;
  }): Promise<Proposal> {
    return PlanActions.propose({
      source: "plan",
      source_kind: "human",
      kind: "calendar_block",
      explanation: `Scheduled ${input.task.title} from the plan.`,
      idempotency_key: input.key,
      payload: {
        task_id: input.task.id,
        domain: input.task.domain,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        timezone: input.timeZone,
        allow_custom_title: true,
        title: input.task.title,
        fixed: false,
      },
    });
  }

  static updateBlock(input: {
    block: CalendarBlock;
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    key: string;
    explanation: string;
  }): Promise<Proposal> {
    return PlanActions.propose({
      source: "plan",
      source_kind: "human",
      kind: "calendar_update",
      explanation: input.explanation,
      idempotency_key: input.key,
      payload: {
        event_key: input.block.id,
        task_id: input.block.task_id,
        domain: input.block.domain,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        timezone: input.timeZone,
        allow_custom_title: true,
        title: input.title,
      },
    });
  }

  static cancelBlock(block: CalendarBlock, title: string, key: string): Promise<Proposal> {
    return PlanActions.propose({
      source: "plan",
      source_kind: "human",
      kind: "calendar_cancel",
      explanation: `Removed ${title} from the plan.`,
      idempotency_key: key,
      payload: { event_key: block.id, task_id: block.task_id },
    });
  }

  static setStatus(task: Task, status: Task["status"]): Promise<Task> {
    return api<Task>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expected_version: task.version, status }),
    });
  }

  static createTask(title: string, estimate: number | null): Promise<Task> {
    const body: Record<string, unknown> = { title, domain: "personal", on_today: false };
    if (estimate != null) body.estimate_hours = estimate;
    return api<Task>("/api/tasks", { method: "POST", body: JSON.stringify(body) });
  }
}
