import type { CalendarBlock, Domain, Proposal, Task } from "../types";
import { PlanBoard } from "./selectors";
import { PlanTime } from "./time";

export interface LaidItem {
  key: string;
  kind: "block" | "proposed";
  blockId?: string;
  proposalId?: string;
  title: string;
  dayKey: string;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  start: Date;
  end: Date;
  fixed: boolean;
  done: boolean;
  ghost: boolean;
  domain: Domain;
}

export interface Connector {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Draft {
  dayKey: string;
  item: Omit<LaidItem, "lane" | "lanes">;
}

export class PlanLayout {
  static pack(spans: { key: string; start: number; end: number }[]): { key: string; lane: number; lanes: number }[] {
    const items = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key));
    const laneOf = new Map<string, number>();
    const laneEnds: number[] = [];
    for (const item of items) {
      let lane = -1;
      for (let index = 0; index < laneEnds.length; index += 1) {
        if (laneEnds[index] <= item.start) {
          lane = index;
          break;
        }
      }
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      laneOf.set(item.key, lane);
    }
    const parent = new Map(items.map((item) => [item.key, item.key]));
    const find = (key: string): string => {
      const parentKey = parent.get(key) ?? key;
      if (parentKey === key) return key;
      const root = find(parentKey);
      parent.set(key, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        const a = items[left];
        const b = items[right];
        if (a.start < b.end && b.start < a.end) union(a.key, b.key);
      }
    }
    const lanesByRoot = new Map<string, number>();
    for (const item of items) {
      const root = find(item.key);
      lanesByRoot.set(root, Math.max(lanesByRoot.get(root) ?? 1, (laneOf.get(item.key) ?? 0) + 1));
    }
    return items.map((item) => ({
      key: item.key,
      lane: laneOf.get(item.key) ?? 0,
      lanes: lanesByRoot.get(find(item.key)) ?? 1,
    }));
  }

  static place(input: {
    dayKeys: string[];
    timeZone: string;
    blocks: CalendarBlock[];
    proposals: Proposal[];
    tasks: Task[];
    find: string;
  }): { byDay: Map<string, LaidItem[]>; links: Connector[]; height: number } {
    const updates = new Map<string, Proposal>();
    for (const proposal of input.proposals) {
      if (proposal.status !== "pending" || proposal.kind !== "calendar_update") continue;
      const eventKey = PlanBoard.payload(proposal).event_key;
      if (typeof eventKey === "string") updates.set(eventKey, proposal);
    }
    const drafts: Draft[] = [];
    for (const block of input.blocks) {
      if (block.status !== "scheduled") continue;
      const start = new Date(block.starts_at);
      const end = new Date(block.ends_at);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
      const title = PlanBoard.titleForBlock(block, input.tasks);
      if (!PlanBoard.matches(title, input.find)) continue;
      const task = input.tasks.find((item) => item.id === block.task_id);
      for (const dayKey of input.dayKeys) {
        const slice = PlanTime.slice(start, end, dayKey, input.timeZone);
        if (!slice) continue;
        drafts.push({
          dayKey,
          item: {
            key: `block:${block.id}:${dayKey}`,
            kind: "block",
            blockId: block.id,
            title,
            dayKey,
            top: slice.top,
            height: slice.height,
            start,
            end,
            fixed: block.fixed,
            done: task?.status === "done",
            ghost: updates.has(block.id),
            domain: block.domain,
          },
        });
      }
    }
    for (const proposal of input.proposals) {
      if (proposal.status !== "pending") continue;
      if (proposal.kind !== "calendar_block" && proposal.kind !== "calendar_update") continue;
      const payload = PlanBoard.payload(proposal);
      if (typeof payload.starts_at !== "string" || typeof payload.ends_at !== "string") continue;
      const start = new Date(payload.starts_at);
      const end = new Date(payload.ends_at);
      if (Number.isNaN(start.getTime()) || end <= start) continue;
      const title = PlanBoard.titleForProposal(proposal, input.tasks);
      if (!PlanBoard.matches(title, input.find)) continue;
      const domain = payload.domain === "work" || payload.domain === "home" || payload.domain === "personal"
        ? payload.domain
        : "personal";
      for (const dayKey of input.dayKeys) {
        const slice = PlanTime.slice(start, end, dayKey, input.timeZone);
        if (!slice) continue;
        drafts.push({
          dayKey,
          item: {
            key: `proposal:${proposal.id}:${dayKey}`,
            kind: "proposed",
            proposalId: proposal.id,
            title,
            dayKey,
            top: slice.top,
            height: slice.height,
            start,
            end,
            fixed: false,
            done: false,
            ghost: false,
            domain,
          },
        });
      }
    }
    const byDay = new Map<string, LaidItem[]>();
    for (const dayKey of input.dayKeys) {
      const group = drafts.filter((draft) => draft.dayKey === dayKey);
      const packed = PlanLayout.pack(group.map((draft) => ({
        key: draft.item.key,
        start: draft.item.top,
        end: draft.item.top + draft.item.height,
      })));
      const lanes = new Map(packed.map((item) => [item.key, item]));
      byDay.set(dayKey, group.map((draft) => {
        const lane = lanes.get(draft.item.key);
        return { ...draft.item, lane: lane?.lane ?? 0, lanes: lane?.lanes ?? 1 };
      }));
    }
    const links: Connector[] = [];
    const flat = [...byDay.values()].flat();
    for (const [eventKey, proposal] of updates) {
      const ghost = flat.find((item) => item.blockId === eventKey && item.dayKey === PlanTime.dayKey(item.start, input.timeZone))
        ?? flat.find((item) => item.blockId === eventKey);
      const proposed = flat.find((item) => item.proposalId === proposal.id && item.dayKey === PlanTime.dayKey(item.start, input.timeZone))
        ?? flat.find((item) => item.proposalId === proposal.id);
      if (!ghost || !proposed) continue;
      const from = PlanLayout.center(ghost, input.dayKeys);
      const to = PlanLayout.center(proposed, input.dayKeys);
      if (!from || !to) continue;
      links.push({ id: proposal.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    }
    const height = input.dayKeys.reduce((max, key) => Math.max(max, PlanTime.dayHeightPx(key, input.timeZone)), 0);
    return { byDay, links, height };
  }

  static center(item: LaidItem, dayKeys: string[]): { x: number; y: number } | null {
    const index = dayKeys.indexOf(item.dayKey);
    if (index < 0 || item.lanes < 1) return null;
    return {
      x: ((index + (item.lane + 0.5) / item.lanes) / dayKeys.length) * 1000,
      y: item.top + item.height / 2,
    };
  }
}
