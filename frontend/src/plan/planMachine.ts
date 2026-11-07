import type { CalendarBlock, Proposal, Task } from "../types";
import type { DragState } from "./store";
import { PlanTime } from "./time";

export interface Span {
  starts_at: string;
  ends_at: string;
}

export interface MachineState {
  drag: DragState | null;
  suppressClick: boolean;
  overrides: Record<string, Span>;
  extraBlocks: CalendarBlock[];
  extraProposals: Proposal[];
  usedKeys: string[];
}

export type MachineEvent =
  | { type: "begin"; drag: DragState }
  | { type: "move"; pointerId: number; x: number; y: number }
  | { type: "up"; pointerId: number }
  | { type: "cancel"; pointerId: number }
  | { type: "escape" }
  | { type: "consume-click" }
  | { type: "optimistic-block"; block: CalendarBlock; key: string }
  | { type: "optimistic-proposal"; proposal: Proposal; key: string }
  | { type: "override"; blockId: string; span: Span }
  | { type: "clear-override"; blockId: string }
  | { type: "rollback"; blockId?: string; key?: string };

export interface MachineResult {
  state: MachineState;
  commit: DragState | null;
}

export class PlanMachine {
  static initial(): MachineState {
    return {
      drag: null,
      suppressClick: false,
      overrides: {},
      extraBlocks: [],
      extraProposals: [],
      usedKeys: [],
    };
  }

  static reduce(state: MachineState, event: MachineEvent): MachineResult {
    switch (event.type) {
      case "begin":
        if (state.usedKeys.includes(event.drag.key)) {
          return { state: { ...state, drag: null }, commit: null };
        }
        return { state: { ...state, drag: event.drag }, commit: null };
      case "move": {
        if (!state.drag || state.drag.pointerId !== event.pointerId) return { state, commit: null };
        const moved = state.drag.moved || Math.hypot(event.x - state.drag.originX, event.y - state.drag.originY) > 4;
        return {
          state: { ...state, drag: { ...state.drag, x: event.x, y: event.y, moved } },
          commit: null,
        };
      }
      case "up": {
        const drag = state.drag;
        if (!drag || drag.pointerId !== event.pointerId) return { state, commit: null };
        if (state.usedKeys.includes(drag.key)) {
          return { state: { ...state, drag: null }, commit: null };
        }
        const usedKeys = drag.moved ? [...state.usedKeys, drag.key] : state.usedKeys;
        return {
          state: { ...state, drag: null, suppressClick: drag.moved || state.suppressClick, usedKeys },
          commit: drag.moved ? drag : null,
        };
      }
      case "cancel":
        if (!state.drag || state.drag.pointerId !== event.pointerId) return { state, commit: null };
        return { state: { ...state, drag: null }, commit: null };
      case "escape":
        return { state: { ...state, drag: null }, commit: null };
      case "consume-click":
        return { state: { ...state, suppressClick: false }, commit: null };
      case "optimistic-block":
        if (state.usedKeys.includes(event.key) && state.extraBlocks.some((block) => block.id === event.block.id)) {
          return { state, commit: null };
        }
        return { state: { ...state, extraBlocks: [...state.extraBlocks, event.block] }, commit: null };
      case "optimistic-proposal":
        return { state: { ...state, extraProposals: [...state.extraProposals, event.proposal] }, commit: null };
      case "override":
        return {
          state: { ...state, overrides: { ...state.overrides, [event.blockId]: event.span } },
          commit: null,
        };
      case "clear-override": {
        const overrides = { ...state.overrides };
        delete overrides[event.blockId];
        return { state: { ...state, overrides }, commit: null };
      }
      case "rollback": {
        const overrides = { ...state.overrides };
        if (event.blockId) delete overrides[event.blockId];
        const extraBlocks = event.key
          ? state.extraBlocks.filter((block) => block.id !== `opt-${event.key}`)
          : state.extraBlocks;
        const extraProposals = event.key
          ? state.extraProposals.filter((proposal) => proposal.id !== `opt-${event.key}`)
          : state.extraProposals;
        return { state: { ...state, overrides, extraBlocks, extraProposals }, commit: null };
      }
      default:
        return { state, commit: null };
    }
  }

  static nudge(
    startIso: string,
    endIso: string,
    minutes: number,
    days: number,
    timeZone: string,
  ): Span | null {
    const start = new Date(startIso);
    const end = new Date(endIso);
    const duration = end.getTime() - start.getTime();
    if (days !== 0) {
      const part = PlanTime.parts(start, timeZone);
      const movedKey = PlanTime.addDaysToKey(PlanTime.dayKey(start, timeZone), days);
      const [year, month, day] = movedKey.split("-").map(Number);
      const moved = PlanTime.localToUtc(year, month, day, part.hour, part.minute, timeZone);
      if (!moved) return null;
      return {
        starts_at: PlanTime.toUtcIso(moved),
        ends_at: PlanTime.toUtcIso(new Date(moved.getTime() + duration)),
      };
    }
    return {
      starts_at: PlanTime.toUtcIso(new Date(start.getTime() + minutes * 60000)),
      ends_at: PlanTime.toUtcIso(new Date(end.getTime() + minutes * 60000)),
    };
  }

  static optimisticBlock(id: string, task: Task, startsAt: string, endsAt: string): CalendarBlock {
    return {
      id,
      task_id: task.id,
      title: task.title,
      description: "",
      starts_at: startsAt,
      ends_at: endsAt,
      domain: task.domain,
      invite_work_email: false,
      fixed: false,
      status: "scheduled",
      sync_state: "simulated",
      written_mode: "demo",
      honest_label: "Saving",
      google_event_id: null,
      version: 0,
    };
  }

  static viewBlocks(blocks: CalendarBlock[], state: MachineState): CalendarBlock[] {
    const adjusted = blocks.map((block) => {
      const next = state.overrides[block.id];
      if (!next) return block;
      if (block.starts_at === next.starts_at && block.ends_at === next.ends_at) return block;
      return { ...block, ...next };
    });
    const seen = new Set(
      adjusted.filter((block) => block.status === "scheduled").map((block) => `${block.task_id}|${block.starts_at}`),
    );
    return [...adjusted, ...state.extraBlocks.filter((block) => !seen.has(`${block.task_id}|${block.starts_at}`))];
  }
}
