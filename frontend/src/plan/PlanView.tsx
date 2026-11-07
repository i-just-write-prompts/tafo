import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, reportFailure } from "../api";
import type { CalendarBlock, Meta, Proposal, Task } from "../types";
import { PlanActions } from "./actions";
import { BlockPopover } from "./BlockPopover";
import { CalendarGrid } from "./CalendarGrid";
import { PlanGestures, PlanHit } from "./gestures";
import { PlanFocus, PlanKeys } from "./keys";
import { PlanBoard } from "./selectors";
import { SettingsStub } from "./SettingsStub";
import { PlanConfig } from "./sync";
import { PlanProvider, type DragState, type PlanStore } from "./store";
import { MIN_BLOCK_PX, PX_PER_MINUTE, PlanTime } from "./time";
import { Toolbar } from "./Toolbar";
import { UnscheduledSidebar } from "./UnscheduledSidebar";

const DENIED = "Denied. Alternates come in a later slice.";

interface ToastState {
  message: string;
  undo?: () => Promise<void>;
}

interface FixedPrompt {
  blockId: string;
  start: Date;
  end: Date;
  action: "move" | "resize";
  key?: string;
}

interface Props {
  meta: Meta;
  tasks: Task[];
  blocks: CalendarBlock[];
  proposals: Proposal[];
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

function optimisticBlock(id: string, task: Task, startsAt: string, endsAt: string): CalendarBlock {
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

export function PlanView(props: Props) {
  const timeZone = props.meta.display_timezone;
  const [mode, setMode] = useState<"week" | "day">("week");
  const [anchor, setAnchor] = useState(() => PlanTime.dayKey(new Date(), timeZone));
  const [find, setFind] = useState("");
  const [sidebarMode, setSidebarMode] = useState<"all" | "unscheduled">("unscheduled");
  const [now, setNow] = useState(() => new Date());
  const [popoverBlockId, setPopoverBlockId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, { starts_at: string; ends_at: string }>>({});
  const [extraBlocks, setExtraBlocks] = useState<CalendarBlock[]>([]);
  const [extraProposals, setExtraProposals] = useState<Proposal[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fixedPrompt, setFixedPrompt] = useState<FixedPrompt | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressRef = useRef(false);
  const busyRef = useRef(new Set<string>());
  const toastRef = useRef<ToastState | null>(null);
  const timerRef = useRef<number | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const dayKeys = useMemo(() => PlanTime.visibleDayKeys(anchor, mode), [anchor, mode]);
  const scrollKey = `${mode}:${dayKeys[0] ?? ""}:${dayKeys[dayKeys.length - 1] ?? ""}`;

  const viewBlocks = useMemo(() => {
    const adjusted = props.blocks.map((block) => {
      const next = overrides[block.id];
      if (!next) return block;
      if (block.starts_at === next.starts_at && block.ends_at === next.ends_at) return block;
      return { ...block, ...next };
    });
    const seen = new Set(adjusted.filter((block) => block.status === "scheduled").map((block) => `${block.task_id}|${block.starts_at}`));
    return [...adjusted, ...extraBlocks.filter((block) => !seen.has(`${block.task_id}|${block.starts_at}`))];
  }, [props.blocks, overrides, extraBlocks]);

  const viewProposals = useMemo(() => {
    const seen = new Set(props.proposals.map((proposal) => {
      const payload = PlanBoard.payload(proposal);
      return `${payload.task_id}|${payload.starts_at}`;
    }));
    const blocked = new Set(props.blocks.filter((block) => block.status === "scheduled").map((block) => `${block.task_id}|${block.starts_at}`));
    const extras = extraProposals.filter((proposal) => {
      const payload = proposal.payload;
      const key = `${payload.task_id}|${payload.starts_at}`;
      return !seen.has(key) && !blocked.has(key);
    });
    return [...props.proposals, ...extras];
  }, [props.proposals, props.blocks, extraProposals]);

  const blocksRef = useRef(viewBlocks);
  blocksRef.current = viewBlocks;
  const proposalsRef = useRef(viewProposals);
  proposalsRef.current = viewProposals;

  function showToast(message: string, undo?: () => Promise<void>) {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    const next = { message, undo };
    toastRef.current = next;
    setToast(next);
    timerRef.current = window.setTimeout(() => {
      if (toastRef.current === next) {
        toastRef.current = null;
        setToast(null);
      }
    }, 8000);
  }

  async function fail(error: unknown) {
    await reportFailure(error, propsRef.current.onRefresh, (message) => {
      propsRef.current.onError(message);
      showToast(message);
    });
    if (!(error instanceof ApiError && error.code === "version_conflict")) {
      try {
        await propsRef.current.onRefresh();
      } catch {
        /* the banner already explains a dead API */
      }
    }
  }

  function hold(id: string): boolean {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusyIds(new Set(busyRef.current));
    return true;
  }

  function release(id: string) {
    busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
  }

  function clearOptimistic(key: string) {
    setExtraBlocks((prev) => prev.filter((block) => block.id !== `opt-${key}`));
    setExtraProposals((prev) => prev.filter((proposal) => proposal.id !== `opt-${key}`));
  }

  async function scheduleTask(taskId: string, dayKey: string, startMin: number, key: string) {
    if (!hold(taskId)) return;
    const task = propsRef.current.tasks.find((item) => item.id === taskId);
    if (!task) {
      release(taskId);
      return;
    }
    const duration = PlanTime.minutesFromEstimate(task.estimate_hours);
    const start = new Date(PlanTime.midnight(dayKey, timeZone).getTime() + startMin * 60000);
    const end = new Date(start.getTime() + duration * 60000);
    const startsAt = PlanTime.toUtcIso(start);
    const endsAt = PlanTime.toUtcIso(end);
    const auto = PlanConfig.autoApprove(propsRef.current.meta.human_edits_auto_approve);
    if (auto) setExtraBlocks((prev) => [...prev, optimisticBlock(`opt-${key}`, task, startsAt, endsAt)]);
    else {
      setExtraProposals((prev) => [...prev, {
        id: `opt-${key}`,
        source: "plan",
        source_kind: "human",
        kind: "calendar_block",
        status: "pending",
        explanation: "Scheduled from the plan.",
        payload: { task_id: task.id, starts_at: startsAt, ends_at: endsAt, title: task.title, domain: task.domain },
        edited_payload: null,
        availability: null,
        version: 1,
      }]);
    }
    try {
      const proposal = await PlanActions.schedule({ task, startsAt, endsAt, timeZone, key });
      let blockId: string | null = null;
      if (auto) {
        const decided = await PlanActions.approve(proposal);
        blockId = decided.block?.id ?? null;
      }
      await propsRef.current.onRefresh();
      clearOptimistic(key);
      showToast(`Scheduled ${task.title}.`, async () => {
        if (blockId) {
          const cancel = await PlanActions.cancelBlock(
            { id: blockId, task_id: task.id } as CalendarBlock,
            task.title,
            PlanActions.gestureKey("plan.undo"),
          );
          await PlanActions.approve(cancel);
          return;
        }
        await PlanActions.reject(proposal, "Undone.");
      });
    } catch (error) {
      clearOptimistic(key);
      await fail(error);
    } finally {
      release(taskId);
    }
  }

  async function writeRange(
    block: CalendarBlock,
    start: Date,
    end: Date,
    action: "move" | "resize",
    acknowledge: boolean,
    key?: string,
  ) {
    if (!hold(block.id)) return;
    const startsAt = PlanTime.toUtcIso(start);
    const endsAt = PlanTime.toUtcIso(end);
    const originStart = block.starts_at;
    const originEnd = block.ends_at;
    const title = PlanBoard.titleForBlock(block, propsRef.current.tasks);
    setOverrides((prev) => ({ ...prev, [block.id]: { starts_at: startsAt, ends_at: endsAt } }));
    try {
      const proposal = await PlanActions.updateBlock({
        block,
        title,
        startsAt,
        endsAt,
        timeZone,
        key: key ?? PlanActions.gestureKey(action === "resize" ? "plan.resize" : "plan.move"),
        explanation: action === "resize" ? `Resized ${title} on the plan.` : `Moved ${title} on the plan.`,
      });
      if (PlanConfig.autoApprove(propsRef.current.meta.human_edits_auto_approve)) {
        await PlanActions.approve(proposal, acknowledge);
      }
      await propsRef.current.onRefresh();
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[block.id];
        return next;
      });
      showToast(`${action === "resize" ? "Resized" : "Moved"} ${title}.`, async () => {
        const current = blocksRef.current.find((item) => item.id === block.id) ?? block;
        const inverse = await PlanActions.updateBlock({
          block: current,
          title,
          startsAt: originStart,
          endsAt: originEnd,
          timeZone,
          key: PlanActions.gestureKey("plan.undo"),
          explanation: `Undid a change to ${title}.`,
        });
        if (PlanConfig.autoApprove(propsRef.current.meta.human_edits_auto_approve)) {
          await PlanActions.approve(inverse, current.fixed || acknowledge);
        }
      });
    } catch (error) {
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[block.id];
        return next;
      });
      await fail(error);
    } finally {
      release(block.id);
    }
  }

  function commitRange(blockId: string, start: Date, end: Date, action: "move" | "resize", key?: string) {
    const server = propsRef.current.blocks.find((item) => item.id === blockId);
    const view = blocksRef.current.find((item) => item.id === blockId);
    if (!server || !view || server.id.startsWith("opt-")) return;
    const sameStart = Math.abs(start.getTime() - new Date(view.starts_at).getTime()) < 1000;
    const sameEnd = Math.abs(end.getTime() - new Date(view.ends_at).getTime()) < 1000;
    if (sameStart && sameEnd) return;
    if (end.getTime() - start.getTime() > 12 * 60 * 60000) {
      showToast("Blocks stay within 12 hours.");
      return;
    }
    if (server.fixed) {
      setFixedPrompt({ blockId, start, end, action, key });
      return;
    }
    void writeRange(server, start, end, action, false, key);
  }

  async function approveIds(list: Proposal[]) {
    const real = list.filter((proposal) => (
      !proposal.id.startsWith("opt-") && proposal.status === "pending" && !busyRef.current.has(proposal.id)
    ));
    if (real.length === 0) return;
    for (const proposal of real) hold(proposal.id);
    let approved = 0;
    try {
      for (const proposal of real) {
        await PlanActions.approve(proposal, false);
        approved += 1;
      }
      await propsRef.current.onRefresh();
      showToast(approved === 1 ? "Approved." : `Approved ${approved}.`);
    } catch (error) {
      await fail(error);
    } finally {
      for (const proposal of real) release(proposal.id);
    }
  }

  async function approve(id: string) {
    const proposal = proposalsRef.current.find((item) => item.id === id);
    if (!proposal) return;
    await approveIds([proposal]);
  }

  async function deny(id: string) {
    const proposal = proposalsRef.current.find((item) => item.id === id);
    if (!proposal || proposal.id.startsWith("opt-") || !hold(id)) return;
    try {
      await PlanActions.reject(proposal, DENIED);
      await propsRef.current.onRefresh();
      showToast(DENIED);
    } catch (error) {
      await fail(error);
    } finally {
      release(id);
    }
  }

  function approveDay(dayKey: string) {
    void approveIds(PlanBoard.pendingOnDays(proposalsRef.current, [dayKey], timeZone));
  }

  function approveAll() {
    void approveIds(PlanBoard.pendingOnDays(proposalsRef.current, dayKeys, timeZone));
  }

  async function toggleDone(blockId: string) {
    const block = blocksRef.current.find((item) => item.id === blockId);
    const task = propsRef.current.tasks.find((item) => item.id === block?.task_id);
    if (!block || !task || !hold(task.id)) return;
    const next = task.status === "done" ? "todo" : "done";
    try {
      const updated = await PlanActions.setStatus(task, next);
      await propsRef.current.onRefresh();
      showToast(next === "done" ? `Marked ${task.title} done.` : `Marked ${task.title} not done.`, async () => {
        await PlanActions.setStatus(updated, task.status);
      });
    } catch (error) {
      await fail(error);
    } finally {
      release(task.id);
    }
  }

  async function removeBlock(blockId: string) {
    const block = propsRef.current.blocks.find((item) => item.id === blockId);
    if (!block || !hold(block.id)) return;
    const title = PlanBoard.titleForBlock(block, propsRef.current.tasks);
    try {
      const proposal = await PlanActions.cancelBlock(block, title, PlanActions.gestureKey("plan.cancel"));
      if (PlanConfig.autoApprove(propsRef.current.meta.human_edits_auto_approve)) {
        await PlanActions.approve(proposal, block.fixed);
      }
      setPopoverBlockId(null);
      await propsRef.current.onRefresh();
      showToast(`Removed ${title}.`);
    } catch (error) {
      await fail(error);
    } finally {
      release(block.id);
    }
  }

  function saveTimes(blockId: string, dayKey: string, time: string, durationMin: number) {
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const dayMinutes = PlanTime.dayMinutes(dayKey, timeZone);
    const total = Math.min(Math.max(0, PlanTime.snapMinutes(hour * 60 + minute)), Math.max(0, dayMinutes - 15));
    const [year, month, day] = dayKey.split("-").map(Number);
    const start = PlanTime.localToUtc(year, month, day, Math.floor(total / 60), total % 60, timeZone);
    if (!start) {
      showToast("That time doesn't exist on this day.");
      return;
    }
    const duration = Math.min(12 * 60, Math.max(15, durationMin));
    commitRange(blockId, start, new Date(start.getTime() + duration * 60000), "move");
  }

  function nudge(blockId: string, minutes: number, days: number) {
    const block = blocksRef.current.find((item) => item.id === blockId);
    if (!block || block.id.startsWith("opt-")) return;
    const start = new Date(block.starts_at);
    const end = new Date(block.ends_at);
    const duration = end.getTime() - start.getTime();
    if (days !== 0) {
      const part = PlanTime.parts(start, timeZone);
      const movedKey = PlanTime.addDaysToKey(PlanTime.dayKey(start, timeZone), days);
      const [year, month, day] = movedKey.split("-").map(Number);
      const moved = PlanTime.localToUtc(year, month, day, part.hour, part.minute, timeZone);
      if (!moved) {
        showToast("That time doesn't exist on this day.");
        return;
      }
      commitRange(blockId, moved, new Date(moved.getTime() + duration), "move");
      return;
    }
    commitRange(blockId, new Date(start.getTime() + minutes * 60000), new Date(end.getTime() + minutes * 60000), "move");
  }

  async function addTask(title: string, estimate: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    let hours: number | null = null;
    if (estimate.trim()) {
      hours = Number(estimate);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 100) {
        showToast("Estimate must be hours greater than 0.");
        return;
      }
    }
    try {
      await PlanActions.createTask(trimmed, hours);
      await propsRef.current.onRefresh();
    } catch (error) {
      await fail(error);
      throw error;
    }
  }

  async function runUndo() {
    const current = toastRef.current;
    if (!current?.undo) return;
    toastRef.current = null;
    setToast(null);
    try {
      await current.undo();
      await propsRef.current.onRefresh();
      showToast("Undone.");
    } catch (error) {
      await fail(error);
    }
  }

  function finishDrag(current: DragState, x: number, y: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (current.kind === "schedule") {
      if (!current.moved || !current.taskId) return;
      const column = PlanHit.column(scroller, x, y);
      if (!column) return;
      const startMin = PlanGestures.dropStart(y, column.top, 0, PlanTime.dayMinutes(column.dayKey, timeZone));
      void scheduleTask(current.taskId, column.dayKey, startMin, current.key);
      return;
    }
    if (!current.blockId) return;
    if (!current.moved) return;
    const column = PlanHit.column(scroller, x, y);
    if (!column) return;
    const block = blocksRef.current.find((item) => item.id === current.blockId);
    if (!block) return;
    const dayMinutes = PlanTime.dayMinutes(column.dayKey, timeZone);
    if (current.kind === "resize") {
      const midnight = PlanTime.midnight(column.dayKey, timeZone).getTime();
      const startMin = (new Date(block.starts_at).getTime() - midnight) / 60000;
      const endMin = PlanGestures.resizeEnd(y, column.top, Math.max(0, startMin), dayMinutes);
      let end = new Date(midnight + endMin * 60000);
      const minEnd = new Date(new Date(block.starts_at).getTime() + 15 * 60000);
      if (end < minEnd) end = minEnd;
      commitRange(block.id, new Date(block.starts_at), end, "resize", current.key);
      return;
    }
    const startMin = PlanGestures.dropStart(y, column.top, current.grabMin, dayMinutes);
    const start = new Date(PlanTime.midnight(column.dayKey, timeZone).getTime() + startMin * 60000);
    const end = new Date(start.getTime() + current.durationMin * 60000);
    commitRange(block.id, start, end, "move", current.key);
  }

  const finishRef = useRef(finishDrag);
  finishRef.current = finishDrag;

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return undefined;
    delete node.dataset.scrolled;
    const apply = () => {
      if (node.clientHeight < 80) return;
      node.scrollTop = PlanTime.initialScrollTop(dayKeys, new Date(), timeZone, node.clientHeight);
      node.dataset.scrolled = "1";
    };
    apply();
    const observer = new ResizeObserver(() => {
      if (node.dataset.scrolled === "1") return;
      apply();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollKey, timeZone, dayKeys]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const moved = current.moved || Math.hypot(event.clientX - current.originX, event.clientY - current.originY) > 4;
      const next = { ...current, x: event.clientX, y: event.clientY, moved };
      dragRef.current = next;
      setDrag(next);
    }
    function onUp(event: PointerEvent) {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      if (current.moved) {
        suppressRef.current = true;
        window.setTimeout(() => {
          suppressRef.current = false;
        }, 0);
      }
      finishRef.current(current, event.clientX, event.clientY);
    }
    function onCancel(event: PointerEvent) {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      dragRef.current = null;
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && dragRef.current) {
        dragRef.current = null;
        setDrag(null);
        event.preventDefault();
        return;
      }
      const command = PlanKeys.command({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        target: event.target instanceof HTMLElement
          ? {
              tagName: event.target.tagName,
              isContentEditable: event.target.isContentEditable,
              type: event.target instanceof HTMLInputElement ? event.target.type : undefined,
            }
          : null,
      });
      if (!command) return;
      if (command === "escape") {
        event.preventDefault();
        if (fixedPrompt) {
          setFixedPrompt(null);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (popoverBlockId) {
          setPopoverBlockId(null);
          return;
        }
        if (find) {
          setFind("");
          findRef.current?.blur();
          return;
        }
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return;
      }
      if (command === "undo") {
        event.preventDefault();
        void runUndo();
        return;
      }
      if (command === "today") {
        event.preventDefault();
        setAnchor(PlanTime.dayKey(new Date(), timeZone));
        return;
      }
      if (command === "week") {
        event.preventDefault();
        setMode("week");
        return;
      }
      if (command === "day") {
        event.preventDefault();
        setMode("day");
        return;
      }
      if (command === "quick-add") {
        event.preventDefault();
        quickAddRef.current?.focus();
        return;
      }
      if (command === "find") {
        event.preventDefault();
        findRef.current?.focus();
        return;
      }
      const focus = PlanFocus.ids();
      if (command === "approve" && focus.proposalId) {
        event.preventDefault();
        void approve(focus.proposalId);
        return;
      }
      if (command === "deny" && focus.proposalId) {
        event.preventDefault();
        void deny(focus.proposalId);
        return;
      }
      if (command === "toggle-done" && focus.blockId) {
        event.preventDefault();
        void toggleDone(focus.blockId);
        return;
      }
      if (focus.blockId && (command === "arrow-up" || command === "arrow-down" || command === "arrow-left" || command === "arrow-right")) {
        event.preventDefault();
        if (command === "arrow-up") nudge(focus.blockId, -15, 0);
        if (command === "arrow-down") nudge(focus.blockId, 15, 0);
        if (command === "arrow-left") nudge(focus.blockId, 0, -1);
        if (command === "arrow-right") nudge(focus.blockId, 0, 1);
        return;
      }
      if (command === "arrow-left") {
        event.preventDefault();
        setAnchor((current) => PlanTime.addDaysToKey(current, mode === "week" ? -7 : -1));
      }
      if (command === "arrow-right") {
        event.preventDefault();
        setAnchor((current) => PlanTime.addDaysToKey(current, mode === "week" ? 7 : 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ghostTitle = drag?.kind === "schedule"
    ? props.tasks.find((task) => task.id === drag.taskId)?.title ?? "Schedule"
    : "Move";

  const store: PlanStore = {
    meta: props.meta,
    tasks: props.tasks,
    blocks: viewBlocks,
    proposals: viewProposals,
    timeZone,
    mode,
    dayKeys,
    now,
    find,
    sidebarMode,
    popoverBlockId,
    busyIds,
    drag,
    scrollerRef,
    quickAddRef,
    findRef,
    setSidebarMode,
    setFind,
    setMode,
    goToday: () => setAnchor(PlanTime.dayKey(new Date(), timeZone)),
    shift: (direction) => setAnchor((current) => PlanTime.addDaysToKey(current, mode === "week" ? direction * 7 : direction)),
    openSettings: () => setSettingsOpen(true),
    beginDrag: (next) => {
      dragRef.current = next;
      setDrag(next);
    },
    takeClick: () => {
      if (!suppressRef.current) return false;
      suppressRef.current = false;
      return true;
    },
    openPopover: (blockId) => {
      if (blockId.startsWith("opt-")) return;
      setPopoverBlockId(blockId);
    },
    closePopover: () => setPopoverBlockId(null),
    approve: (id) => void approve(id),
    deny: (id) => void deny(id),
    approveDay,
    approveAll,
    toggleDone: (blockId) => void toggleDone(blockId),
    removeBlock: (blockId) => void removeBlock(blockId),
    saveTimes,
    addTask,
  };

  return (
    <PlanProvider value={store}>
      <div className="plan">
        <UnscheduledSidebar />
        <div className="plan-main">
          <Toolbar />
          <CalendarGrid />
        </div>
      </div>
      {popoverBlockId && <BlockPopover />}
      {settingsOpen && <SettingsStub meta={props.meta} onClose={() => setSettingsOpen(false)} />}
      {fixedPrompt && (
        <div className="scrim">
          <div className="popover" role="dialog" aria-labelledby="fixed-title">
            <h2 id="fixed-title">Change this fixed block?</h2>
            <p>This appointment is fixed. It stays where it is unless you confirm the change.</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const server = props.blocks.find((item) => item.id === fixedPrompt.blockId);
                  const prompt = fixedPrompt;
                  setFixedPrompt(null);
                  if (server) void writeRange(server, prompt.start, prompt.end, prompt.action, true, prompt.key);
                }}
              >
                Change it
              </button>
              <button type="button" data-testid="fixed-cancel" onClick={() => setFixedPrompt(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status" data-testid={toast.undo ? "undo-toast" : "plan-toast"}>
          <p>{toast.message}</p>
          {toast.undo && <button type="button" onClick={() => void runUndo()}>Undo</button>}
        </div>
      )}
      {drag && drag.moved && drag.kind !== "resize" && (
        <div
          className="drag-ghost"
          style={{
            width: 168,
            height: Math.max(MIN_BLOCK_PX, drag.durationMin * PX_PER_MINUTE),
            transform: `translate(${drag.x + 12}px, ${drag.y - (drag.kind === "move" ? drag.grabMin * PX_PER_MINUTE : 8)}px)`,
          }}
        >
          {ghostTitle}
        </div>
      )}
    </PlanProvider>
  );
}
