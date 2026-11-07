import { createContext, useContext, type ReactNode, type RefObject } from "react";
import type { CalendarBlock, Meta, Proposal, Task } from "../types";

export interface DragState {
  kind: "schedule" | "move" | "resize";
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  moved: boolean;
  key: string;
  taskId?: string;
  blockId?: string;
  durationMin: number;
  grabMin: number;
  originStart?: string;
  originEnd?: string;
}

export interface PlanStore {
  meta: Meta;
  tasks: Task[];
  blocks: CalendarBlock[];
  proposals: Proposal[];
  timeZone: string;
  mode: "week" | "day";
  dayKeys: string[];
  now: Date;
  find: string;
  sidebarMode: "all" | "unscheduled";
  popoverBlockId: string | null;
  busyIds: ReadonlySet<string>;
  drag: DragState | null;
  scrollerRef: RefObject<HTMLDivElement>;
  quickAddRef: RefObject<HTMLInputElement>;
  findRef: RefObject<HTMLInputElement>;
  setSidebarMode: (mode: "all" | "unscheduled") => void;
  setFind: (value: string) => void;
  setMode: (mode: "week" | "day") => void;
  goToday: () => void;
  shift: (direction: -1 | 1) => void;
  openSettings: () => void;
  beginDrag: (drag: DragState) => void;
  takeClick: () => boolean;
  openPopover: (blockId: string) => void;
  closePopover: () => void;
  approve: (id: string) => void;
  deny: (id: string) => void;
  approveDay: (dayKey: string) => void;
  approveAll: () => void;
  toggleDone: (blockId: string) => void;
  removeBlock: (blockId: string) => void;
  saveTimes: (blockId: string, dayKey: string, time: string, durationMin: number) => void;
  addTask: (title: string, estimate: string) => Promise<void>;
}

const PlanContext = createContext<PlanStore | null>(null);

export function PlanProvider({ value, children }: { value: PlanStore; children: ReactNode }) {
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanStore {
  const value = useContext(PlanContext);
  if (!value) throw new Error("Plan store is missing");
  return value;
}
