import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ApiError, reportFailure } from "../api";
import { calendar, type PlanApprovalInput, type PlanMoveInput } from "../calendar/client";
import { PlanMachine } from "../plan/planMachine";
import { PlanBoard } from "../plan/selectors";
import { PlanTime, PX_PER_MINUTE } from "../plan/time";
import { MonthGridSheet } from "../v4/MonthGridSheet";
import {
  crossDayHoverCell,
  crossDayIdle,
  crossDayInterrupt,
  crossDayLift,
  crossDayRelease,
  crossDayStripEnter,
  crossDayStripLeave,
  crossDaySurfaceAt,
  crossDayTick,
  dwellProgress,
  type CrossDayState,
} from "../v4/crossDay";
import { coversDayKey, isAllDayEvent, isMultiDayEvent, multiDayLabel } from "../v4/eventShape";
import { TAFO_REV } from "../rev";
import type { CalendarBlock, Meta, OutboxOperation, Proposal, Task } from "../types";
import {
  DAY_GUTTER,
  DAY_ORIGIN,
  DAY_PX,
  WEEK_GUTTER,
  WEEK_ORIGIN,
  WEEK_PX,
  crossesWorkHours,
  dayBoxes,
  dayTaps,
  dayY,
  moveByPointer,
  paintedWeekSpan,
  weekBoxes,
  weekColumnWidth,
  weekY,
  type DayBox,
  type TapBox,
} from "./geometry";
import {
  PLAN_HINT,
  revertToast,
  SYNC_DEMO,
  TIP_TEXT,
  SAVED_REFRESH,
  approveLabel,
  approvedToast,
  bannerText,
  compactConflict,
  partialPlanToast,
  clock,
  clockMinutes,
  dayName,
  dayTitle,
  denyToast,
  domainLabel,
  exactClock,
  gutterClock,
  quickToast,
  refusedMoveToast,
  unplacedToast,
  rangeLabel,
  shortRange,
  weekTitle,
} from "./format";
import { COMMIT_PX, gestureDown, gestureMove, gestureUp, HOLD_MS, holdReady, type Gesture } from "./gesture";
import { CheckGlyph, Chevron, InfoGlyph, MoreGlyph, PlanGlyph, SearchGlyph, Sparkle } from "./icons";
import { ALL_SHOWN, buildEvents, showSummary, visibleEvents, withMove, type CalEvent, type ShowFilters } from "./model";
import { approveDisabled, conflictingMoveIds, enterPlan, exitPlan, includedIds, loadPlan, pendingProposalIds, proposalsOnDays, retainMoves, sameInstant, savePlan, stageMove, toggleSkip, type PlanSession, type StagedMove } from "./session";
import { wrapWeekTitle } from "./titles";
import { showUndo, type UndoToast } from "./undo";
import {
  CrossDayBanner,
  DwellRing,
  HourRows,
  NextDayRow,
  NowChip,
  ReentryHint,
  crossDayMoveLabel,
  dayRowsFor,
  stripCellId,
  useGridPager,
  useScrollHour,
  weekGridHeightPx,
  weekHourCount,
  weekRowsFor,
} from "./calendarV4";
import "./v3.css";

type CalendarView = "day" | "week" | "month";

const TIP_KEY = "tafo.planTipShown";

type Overlay =
  | null
  | { kind: "menu" }
  | { kind: "view" }
  | { kind: "show" }
  | { kind: "search" }
  | { kind: "settings" }
  | { kind: "sync" }
  | { kind: "unscheduled" }
  | { kind: "event"; id: string }
  | { kind: "review" }
  | { kind: "revert" }
  | { kind: "fixed"; id: string; start: string; end: string }
  | { kind: "jump"; moveEventId?: string }
  | { kind: "month" };

interface DragOrigin {
  id: string;
  startHour: number;
  duration: number;
  dayIndex: number;
  dayKey: string;
}

interface Preview {
  id: string;
  dayKey: string;
  dayIndex: number;
  startHour: number;
}

interface SettleBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Settle {
  id: string;
  park: SettleBox;
  rest?: SettleBox;
  live: boolean;
}

interface Props {
  meta: Meta | null;
  tasks: Task[];
  blocks: CalendarBlock[];
  proposals: Proposal[];
  outbox: OutboxOperation[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

function atHour(dayKey: string, hour: number, timeZone: string): string | null {
  let whole = Math.floor(hour);
  let minute = Math.round((hour - whole) * 60);
  if (minute === 60) {
    whole += 1;
    minute = 0;
  }
  let key = dayKey;
  if (whole >= 24) {
    key = PlanTime.addDaysToKey(dayKey, Math.floor(whole / 24));
    whole %= 24;
  }
  const [year, month, day] = key.split("-").map(Number);
  const instant = PlanTime.localToUtc(year, month, day, whole, minute, timeZone);
  return instant ? PlanTime.toUtcIso(instant) : null;
}

function eventLabel(event: CalEvent): string {
  const when = `${dayTitle(event.dayKey)}, ${rangeLabel(event.startHour, event.endHour)}`;
  const state = event.state === "proposed"
    ? ", Proposed"
    : event.state === "unplaced"
      ? ", Not on calendar"
      : event.state === "done"
        ? ", Done"
        : "";
  return `${event.title}, ${when}${state}`;
}

const APPROVE_CLICK_SHIELD_MS = 700;

export function CalendarShell(props: Props) {
  const timeZone = props.meta?.display_timezone || "America/Indianapolis";
  const [mode, setMode] = useState<CalendarView>("day");
  const [anchor, setAnchor] = useState(() => PlanTime.dayKey(new Date(), timeZone));
  const [monthAnchor, setMonthAnchor] = useState(() => PlanTime.dayKey(new Date(), timeZone));
  const [plan, setPlanState] = useState<PlanSession>(() => loadPlan());
  const [trayOpen, setTrayOpen] = useState(false);
  function setPlan(next: PlanSession | ((current: PlanSession) => PlanSession)) {
    setPlanState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      savePlan(resolved);
      return resolved;
    });
  }
  const [filters, setFilters] = useState<ShowFilters>(ALL_SHOWN);
  const [query, setQuery] = useState("");
  const [overlay, setOverlayState] = useState<Overlay>(null);
  const [sheetClosing, setSheetClosing] = useState(false);
  const overlayRef = useRef<Overlay>(null);
  const closeTimer = useRef<number | null>(null);
  overlayRef.current = overlay;

  function setOverlay(next: Overlay) {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (next === null && overlayRef.current && !reduce) {
      setSheetClosing(true);
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setSheetClosing(false);
        setOverlayState(null);
      }, 160);
      return;
    }
    setSheetClosing(false);
    setOverlayState(next);
  }
  const [gesture, setGesture] = useState<Gesture>({ phase: "idle" });
  const [toast, setToast] = useState<UndoToast<null> | null>(null);
  const [undo, setUndo] = useState<(() => Promise<void>) | null>(null);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [tip, setTip] = useState(false);
  const [glow, setGlow] = useState<string[]>([]);
  const [live, setLive] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [overrides, setOverrides] = useState<Record<string, { start: string; end: string }>>({});
  const [width, setWidth] = useState(390);
  const [frame, setFrame] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const quickInFlight = useRef(false);
  const pendingQuick = useRef<{ event: CalEvent; start: string; end: string; acknowledgeFixed: boolean } | null>(null);
  function setBusyFlag(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  const gridRef = useRef<HTMLDivElement>(null);
  const [crossDay, setCrossDay] = useState<CrossDayState>(crossDayIdle);
  const crossDayRef = useRef(crossDay);
  crossDayRef.current = crossDay;
  const [traySaveMessage, setTraySaveMessage] = useState<string | null>(null);
  const [trayTargetDay, setTrayTargetDay] = useState<string | null>(null);
  const [trayMovedId, setTrayMovedId] = useState<string | null>(null);
  const [traySaveUndo, setTraySaveUndo] = useState<(() => Promise<void>) | null>(null);
  const [crossHighlightId, setCrossHighlightId] = useState<string | null>(null);
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const autoScrollRef = useRef<{ zone: "top" | "bottom" | null; since: number }>({ zone: null, since: 0 });
  const stripDwellTimerRef = useRef(0);
  const [weekStripOffset, setWeekStripOffset] = useState(0);
  const [nowOffscreen, setNowOffscreen] = useState(false);
  const scrollHour = useScrollHour(gridRef);
  const originRef = useRef<DragOrigin | null>(null);
  const gestureRef = useRef<Gesture>({ phase: "idle" });
  const settleFrom = useRef<{ id: string; left: number; top: number; width: number; height: number } | null>(null);
  const snapRef = useRef<number | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);
  const [lockId, setLockId] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const approving = useRef(false);
  const toastToken = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const serverEvents = useMemo(
    () => buildEvents(props.tasks, props.blocks, props.proposals, timeZone, props.outbox),
    [props.tasks, props.blocks, props.proposals, props.outbox, timeZone],
  );
  const monday = PlanTime.addDaysToKey(PlanTime.mondayKey(anchor), weekStripOffset * 7);
  const weekKeys = PlanTime.visibleDayKeys(monday, "week");
  const gridDayKey = crossDay.phase === "carrying" && crossDay.peeked ? crossDay.viewDayKey : anchor;
  const pager = useGridPager({
    width,
    enabled: gesture.phase !== "lifted" && mode !== "month",
    onPrev: () => {
      if (mode === "week") setWeekStripOffset((offset) => offset - 1);
      else setAnchor(PlanTime.addDaysToKey(anchor, -1));
    },
    onNext: () => {
      if (mode === "week") setWeekStripOffset((offset) => offset + 1);
      else setAnchor(PlanTime.addDaysToKey(anchor, 1));
    },
  });
  const todayKey = PlanTime.dayKey(now, timeZone);
  const nowParts = PlanTime.parts(now, timeZone);
  const nowHour = nowParts.hour + nowParts.minute / 60;

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || anchor !== todayKey || mode !== "day") {
      setNowOffscreen(false);
      return undefined;
    }
    const read = () => {
      const y = nowHour * 60 * PX_PER_MINUTE;
      const viewTop = grid.scrollTop;
      const viewBottom = viewTop + grid.clientHeight;
      setNowOffscreen(y < viewTop - 8 || y > viewBottom - 8);
    };
    read();
    grid.addEventListener("scroll", read, { passive: true });
    return () => grid.removeEventListener("scroll", read);
  }, [anchor, todayKey, nowHour, mode]);

  const baseEvents = useMemo(() => {
    return serverEvents.map((event) => {
      const move = plan.active ? plan.moves.find((item) => item.id === event.id) : undefined;
      if (move) {
        const placed = withMove(event, move.to.start, move.to.end, timeZone);
        if (event.state === "unplaced") return placed;
        return event.kind === "proposal" ? { ...placed, state: "approved" as const } : placed;
      }
      const override = overrides[event.id];
      if (override) return withMove(event, override.start, override.end, timeZone);
      return event;
    });
  }, [serverEvents, plan, overrides, timeZone]);

  const shown = visibleEvents(baseEvents, filters, overlay?.kind === "search" ? "" : query);
  const dragPreview = previewFrom(
    gesture,
    originRef.current,
    mode === "month" ? "day" : mode,
    monday,
    gridRef.current,
    width,
    gesture.phase === "lifted" ? snapRef.current : null,
    gridDayKey,
    timeZone,
    crossDay.phase === "carrying" && crossDay.peeked,
  );
  if (gesture.phase === "lifted" && dragPreview) snapRef.current = dragPreview.startHour;
  if (gesture.phase === "idle") snapRef.current = null;
  const events = shown.map((event) => {
    if (!dragPreview || dragPreview.id !== event.id) return event;
    const start = atHour(dragPreview.dayKey, dragPreview.startHour, timeZone);
    const end = atHour(dragPreview.dayKey, dragPreview.startHour + (originRef.current?.duration ?? 0.5), timeZone);
    return start && end ? withMove(event, start, end, timeZone) : event;
  });

  const dayEvents = shown.filter((event) => {
    if (event.dayKey === gridDayKey) return true;
    if (crossDay.phase === "carrying" && event.id === crossDay.eventId) return true;
    if ((isMultiDayEvent(event, timeZone) || isAllDayEvent(event, timeZone)) && coversDayKey(event, gridDayKey, timeZone)) return true;
    return false;
  });
  const allDayEvents = dayEvents.filter((event) => isAllDayEvent(event, timeZone));
  const multiDayEvents = dayEvents.filter((event) => isMultiDayEvent(event, timeZone));
  const timedDayEvents = dayEvents.filter((event) => !isAllDayEvent(event, timeZone) && !isMultiDayEvent(event, timeZone));
  const stripSelection = crossDay.phase === "carrying" && crossDay.peeked ? crossDay.viewDayKey : anchor;
  const weekHourMax = weekHourCount(weekKeys, timeZone);
  const weekEvents = shown.filter((event) => weekKeys.includes(event.dayKey));
  const rangeIds = pendingProposalIds(
    proposalsOnDays(baseEvents, mode === "day" || mode === "month" ? [anchor] : weekKeys).map((event) => event.id),
    plan.moves,
  );
  const included = includedIds(rangeIds, plan.skipped);
  const conflictIds = conflictingMoveIds(
    plan.moves,
    props.blocks.map((block) => ({ id: block.id, version: block.version, starts_at: block.starts_at, ends_at: block.ends_at })),
    props.proposals.map((proposal) => ({ id: proposal.id, ...proposalTimes(proposal), version: proposal.version })),
  );
  const conflictText = conflictIds
    .map((id) => plan.moves.find((move) => move.id === id)?.title)
    .filter((title): title is string => Boolean(title))
    .join(", ");
  const conflictLabel = conflictIds.length === 0 ? "" : width < 380 ? compactConflict(conflictIds.length) : `Changed · ${conflictText}`;
  const unsavedFits = bannerText(plan.moves.length, rangeIds.length, true).length < 42;
  const banner = bannerText(plan.moves.length, rangeIds.length, unsavedFits && plan.moves.length > 0 && rangeIds.length === 0);
  const loose = PlanBoard.sidebarTasks(props.tasks, props.blocks, props.proposals, "unscheduled", "");

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || props.loading || mode === "month") return;
    const initKey = mode === "week" ? "week" : `day-${gridDayKey}`;
    if (grid.dataset.scrollInitKey === initKey) return;
    if (mode === "week") {
      grid.scrollTop = 0;
    } else {
      const keys = [gridDayKey];
      grid.scrollTop = PlanTime.initialScrollTop(keys, now, timeZone, grid.clientHeight);
    }
    grid.dataset.scrollInitKey = initKey;
  }, [mode, gridDayKey, weekKeys, now, timeZone, props.loading]);

  useEffect(() => {
    if (gesture.phase === "lifted" && mode === "day" && originRef.current) {
      const grid = gridRef.current;
      setCrossDay(crossDayLift(originRef.current.id, originRef.current.dayKey, (grid?.scrollTop ?? 0) / PX_PER_MINUTE));
    } else if (gesture.phase !== "lifted") {
      setCrossDay((current) => (current.phase === "carrying" ? current : crossDayIdle()));
    }
  }, [gesture.phase, mode, gesture.phase === "lifted" && gesture.phase === "lifted" ? gesture.eventId : ""]);

  useEffect(() => {
    if (crossDay.phase !== "carrying" || !crossDay.hoverDayKey) return undefined;
    const timer = window.setInterval(() => {
      setCrossDay((state) => crossDayTick(state, 20));
    }, 20);
    return () => window.clearInterval(timer);
  }, [crossDay.phase, crossDay.onStrip, crossDay.hoverDayKey]);

  useEffect(() => {
    if (crossDay.phase !== "carrying" || !crossDay.peeked) return undefined;
    const onMove = (clientX: number, clientY: number, pointerId: number, pointerType: string) => {
      if (gestureRef.current.phase !== "idle") return;
      if (crossDaySurfaceAt(clientX, clientY) !== "grid") return;
      resumeCrossDayPointerDrag({ pointerId, clientX, clientY, pointerType });
    };
    const onPointerMove = (native: PointerEvent) => {
      onMove(native.clientX, native.clientY, native.pointerId, native.pointerType);
    };
    const onTouchMove = (native: TouchEvent) => {
      const touch = native.changedTouches[0] ?? native.touches[0];
      if (!touch) return;
      onMove(touch.clientX, touch.clientY, 1, "touch");
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("touchmove", onTouchMove, true);
    };
  }, [crossDay.phase, crossDay.peeked, crossDay.eventId]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || mode !== "day" || gridDayKey !== todayKey) {
      setNowOffscreen(false);
      return undefined;
    }
    const check = () => {
      const nowY = PlanTime.yPx(nowParts.hour * 60 + nowParts.minute);
      const top = grid.scrollTop;
      const bottom = top + grid.clientHeight;
      setNowOffscreen(nowY < top - 8 || nowY > bottom + 8);
    };
    check();
    grid.addEventListener("scroll", check, { passive: true });
    return () => grid.removeEventListener("scroll", check);
  }, [mode, gridDayKey, todayKey, nowParts.hour, nowParts.minute]);

  useEffect(() => {
    setOverrides((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        const block = props.blocks.find((item) => item.id === id);
        const span = current[id];
        if (block && sameInstant(block.starts_at, span.start) && sameInstant(block.ends_at, span.end)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [props.blocks]);

  useEffect(() => {
    const measure = () => {
      setFrame(document.documentElement.dataset.frame === "1");
      setWidth(gridRef.current?.clientWidth || window.innerWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (gridRef.current) observer.observe(gridRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mode, frame]);

  useEffect(() => {
    if (gesture.phase !== "pending") return undefined;
    const started = gesture.started;
    const wait = Math.max(0, HOLD_MS - (performance.now() - started));
    const timer = window.setTimeout(() => {
      setGesture((current) => {
        const next = current.phase === "pending" && current.started === started ? holdReady(current, performance.now()) : current;
        gestureRef.current = next;
        return next;
      });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [gesture.phase, gesture.phase === "pending" ? gesture.started : 0]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOverlay(null);
        setGesture({ phase: "idle" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!overlay) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector(".v3");
    if (shell instanceof HTMLElement) shell.scrollTop = 0;
    const root = document.querySelector(".sheet, .menu, .view-menu");
    root?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [overlay]);

  useEffect(() => {
    if (!toast) return undefined;
    const delay = Math.max(0, toast.until - Date.now());
    const timer = window.setTimeout(() => {
      setToast(null);
      setUndo(null);
      setRetry(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useLayoutEffect(() => {
    const from = settleFrom.current;
    if (!from) return;
    settleFrom.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLockId(null);
      return;
    }
    const face = gridRef.current?.querySelector(`[data-testid="block-${from.id}"] .face`);
    const button = face?.parentElement;
    if (!(face instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      setLockId(null);
      return;
    }
    const next = face.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const park = {
      left: from.left - buttonRect.left,
      top: from.top - buttonRect.top,
      width: from.width,
      height: from.height,
    };
    const same = Math.hypot(next.left - from.left, next.top - from.top) < 0.5
      && Math.abs(next.width - from.width) < 0.5
      && Math.abs(next.height - from.height) < 0.5;
    if (same) {
      setLockId(null);
      return;
    }
    flushSync(() => {
      setSettle({ id: from.id, park, live: false });
    });
  });

  useLayoutEffect(() => {
    if (!settle || settle.live) return undefined;
    const face = gridRef.current?.querySelector(`[data-testid="block-${settle.id}"] .face`);
    if (face instanceof HTMLElement) void face.getBoundingClientRect();
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setSettle((current) => {
          if (!current || current.live) return current;
          const button = gridRef.current?.querySelector(`[data-testid="block-${current.id}"]`);
          const week = gridRef.current?.dataset.testid === "week-grid";
          const rest = week && button instanceof HTMLElement
            ? { left: 0, top: 0, width: button.clientWidth, height: button.clientHeight }
            : undefined;
          return { ...current, live: true, rest };
        });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [settle]);

  useEffect(() => {
    if (!settle?.live) return undefined;
    const timer = window.setTimeout(() => {
      setSettle(null);
      setLockId(null);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [settle]);

  function say(message: string) {
    setLive("");
    window.setTimeout(() => setLive(message), 20);
  }

  function pushToast(message: string, undoFn?: () => Promise<void>, retryFn?: () => Promise<void>) {
    const token = toastToken.current + 1;
    toastToken.current = token;
    setToast(showUndo(message, null, Date.now(), token));
    setUndo(() => undoFn ?? null);
    setRetry(() => retryFn ?? null);
    say(message);
  }

  function glowIds(ids: string[]) {
    setGlow(ids);
    window.setTimeout(() => setGlow([]), 1200);
  }

  async function fail(error: unknown) {
    setOverrides({});
    await reportFailure(error, propsRef.current.onRefresh, (message) => {
      pushToast(message);
    });
  }

  function rememberTip(message: string) {
    try {
      if (localStorage.getItem(TIP_KEY)) return;
      localStorage.setItem(TIP_KEY, "1");
      setTip(true);
      say(`${message}. ${TIP_TEXT}`);
    } catch {
      setTip(true);
    }
  }

  async function retryRefused(outboxId: string, title: string, start: string, end: string, failedMessage = refusedMoveToast(title), eventId?: string) {
    setBusyFlag(true);
    try {
      const result = await calendar.retryOutbox(outboxId);
      if (!calendarWriteLanded({ outbox: result.operation, block: result.block }, start, end)) {
        pushToast(failedMessage, undefined, () => retryRefused(outboxId, title, start, end, failedMessage, eventId));
        return;
      }
      if (eventId) {
        setPlan((current) => retainMoves(current, current.moves.filter((move) => move.id !== eventId).map((move) => move.id)));
      }
      const part = PlanTime.parts(new Date(start), timeZone);
      pushToast(quickToast(title, part.hour + part.minute / 60));
      try {
        await propsRef.current.onRefresh();
      } catch {
        /* The write landed. The next poll catches up. */
      }
    } catch (error) {
      await fail(error);
    } finally {
      setBusyFlag(false);
    }
  }

  function restoreCrossDayView(originDayKey: string, scrollMinutes: number) {
    setAnchor(originDayKey);
    const grid = gridRef.current;
    if (grid) grid.scrollTop = scrollMinutes * PX_PER_MINUTE;
  }

  function stopStripDwell() {
    if (stripDwellTimerRef.current) window.clearInterval(stripDwellTimerRef.current);
    stripDwellTimerRef.current = 0;
  }

  function beginStripDwell(dayKey: string) {
    if (crossDayRef.current.phase !== "carrying") return;
    flushSync(() => {
      setCrossDay((state) => crossDayHoverCell(state.onStrip ? state : crossDayStripEnter(state), dayKey));
    });
    stopStripDwell();
    stripDwellTimerRef.current = window.setInterval(() => {
      setCrossDay((state) => crossDayTick(state, 20));
    }, 20);
  }

  function stripDwellTargetFromPoint(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY);
  if (!(el instanceof Element)) return null;
    const cell = el.closest("[data-strip-key]");
    if (!(cell instanceof HTMLElement)) return null;
    return cell.getAttribute("data-strip-key");
  }

  function resumeCrossDayPointerDrag(pointer: { pointerId: number; clientX: number; clientY: number; pointerType: string }): boolean {
    const state = crossDayRef.current;
    if (state.phase !== "carrying" || !state.peeked || gestureRef.current.phase !== "idle") return false;
    const event =
      baseEvents.find((item) => item.id === state.eventId)
      ?? serverEvents.find((item) => item.id === state.eventId);
    if (!event) return false;
    startGesture(event, pointer);
    const current = gestureRef.current as Gesture;
    if (current.phase !== "pending") return false;
    const lifted = { ...current, phase: "lifted" as const, point: { x: pointer.clientX, y: pointer.clientY } };
    gestureRef.current = lifted;
    flushSync(() => setGesture(lifted));
    return true;
  }

  async function saveQuick(
    event: CalEvent,
    startIso: string,
    endIso: string,
    acknowledgeFixed = false,
    opts?: { deferTray?: boolean },
  ): Promise<{ line: string; targetDay: string; undo: (() => Promise<void>) | null } | null> {
    if (busyRef.current) {
      // Keep a second quick drag. The Approve-all click shield is a separate guard and stays.
      if (quickInFlight.current) {
        pendingQuick.current = { event, start: startIso, end: endIso, acknowledgeFixed };
        setOverrides((current) => ({ ...current, [event.id]: { start: startIso, end: endIso } }));
      }
      return null;
    }
    quickInFlight.current = true;
    const original = { start: event.start, end: event.end };
    setOverrides((current) => ({ ...current, [event.id]: { start: startIso, end: endIso } }));
    setBusyFlag(true);
    try {
      if (event.kind === "proposal") {
        const proposal = propsRef.current.proposals.find((item) => item.id === event.id);
        if (!proposal) return null;
        const saved = await calendar.move({
          kind: "proposal",
          title: event.title,
          startsAt: startIso,
          endsAt: endIso,
          timeZone,
          proposal,
        });
        if (!calendarWriteLanded(saved, startIso, endIso)) {
          setOverrides((current) => {
            const copy = { ...current };
            delete copy[event.id];
            return copy;
          });
          try {
            await propsRef.current.onRefresh();
          } catch {
            /* The approval is on the server. The next poll draws it. */
          }
          const outboxId = saved.outbox?.id;
          const missed = unplacedToast(event.title);
          pushToast(
            missed,
            undefined,
            outboxId ? () => retryRefused(outboxId, event.title, startIso, endIso, missed, event.id) : undefined,
          );
          return null;
        }
        const hour = withMove(event, startIso, endIso, timeZone).startHour;
        const moved = withMove(event, startIso, endIso, timeZone);
        const trayLine = moved.dayKey !== event.dayKey
          ? crossDayMoveLabel(event.title, moved.dayKey, hour)
          : quickToast(event.title, hour);
        if (moved.dayKey !== event.dayKey && opts?.deferTray) {
          return { line: trayLine, targetDay: moved.dayKey, undo: null };
        }
        setTraySaveMessage(trayLine);
        if (moved.dayKey !== event.dayKey) {
          setTrayTargetDay(moved.dayKey);
          setTrayMovedId(event.id);
        }
        pushToast(trayLine);
      } else {
        const block = propsRef.current.blocks.find((item) => item.id === event.id);
        if (!block) return null;
        const saved = await calendar.move({
          kind: "block",
          title: event.title,
          startsAt: startIso,
          endsAt: endIso,
          timeZone,
          acknowledgeFixed,
          block,
        });
        if (!calendarWriteLanded(saved, startIso, endIso)) {
          setOverrides((current) => {
            const copy = { ...current };
            delete copy[event.id];
            return copy;
          });
          const outboxId = saved.outbox?.id;
          const title = event.title;
          pushToast(
            refusedMoveToast(title),
            undefined,
            outboxId ? () => retryRefused(outboxId, title, startIso, endIso, refusedMoveToast(title), event.id) : undefined,
          );
          return null;
        }
        const hour = withMove(event, startIso, endIso, timeZone).startHour;
        const moved = withMove(event, startIso, endIso, timeZone);
        const message = moved.dayKey !== event.dayKey
          ? crossDayMoveLabel(event.title, moved.dayKey, hour)
          : quickToast(event.title, hour);
        const nextBlock = saved.block;
        const undoFn = nextBlock ? async () => {
          await calendar.undo({
            kind: "block",
            title: event.title,
            startsAt: original.start,
            endsAt: original.end,
            timeZone,
            acknowledgeFixed,
            block: nextBlock,
          });
          setOverrides((current) => {
            const copy = { ...current };
            delete copy[event.id];
            return copy;
          });
          await propsRef.current.onRefresh();
        } : undefined;
        if (moved.dayKey !== event.dayKey && opts?.deferTray) {
          return { line: message, targetDay: moved.dayKey, undo: undoFn ?? null };
        }
        setTraySaveMessage(message);
        if (moved.dayKey !== event.dayKey) {
          setTrayTargetDay(moved.dayKey);
          setTrayMovedId(event.id);
        }
        if (undoFn) setTraySaveUndo(() => undoFn);
        pushToast(message, undoFn);
        rememberTip(message);
      }
      glowIds([event.id]);
      try {
        await propsRef.current.onRefresh();
      } catch {
        return null;
      }
      setOverrides((current) => {
        const copy = { ...current };
        delete copy[event.id];
        return copy;
      });
      return null;
    } catch (error) {
      await fail(error);
      return null;
    } finally {
      quickInFlight.current = false;
      const next = pendingQuick.current;
      pendingQuick.current = null;
      setBusyFlag(false);
      if (next) void saveQuick(next.event, next.start, next.end, next.acknowledgeFixed);
    }
  }

  function stagedMove(server: CalEvent, to: { start: string; end: string }, dayKey: string, existing: StagedMove | undefined): StagedMove {
    const sameTarget = existing?.to.start === to.start && existing.to.end === to.end;
    return {
      id: server.id,
      kind: server.kind,
      title: existing?.title || server.title,
      version: existing?.version ?? server.version,
      key: calendar.saveKey("plan", existing?.key, Boolean(existing && sameTarget)),
      from: existing?.from ?? { start: server.start, end: server.end },
      to,
      fromDayKey: existing?.fromDayKey ?? server.dayKey,
      dayKey,
    };
  }

  function stagePreview(eventId: string, preview: Preview) {
    const server = serverEvents.find((item) => item.id === eventId);
    if (!server) return;
    const existing = plan.moves.find((item) => item.id === eventId);
    const duration = server.endHour - server.startHour;
    const start = atHour(preview.dayKey, preview.startHour, timeZone);
    const end = atHour(preview.dayKey, preview.startHour + duration, timeZone);
    if (!start || !end) return;
    const move = stagedMove(server, { start, end }, preview.dayKey, existing);
    setPlan((current) => stageMove(current, move));
  }

  function openEvent(event: CalEvent) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setOverlay({ kind: "event", id: event.id });
  }

  function finishGesture(released: Gesture, surface: "grid" | "strip" | "tray" | "message" = "grid") {
    if (released.phase === "idle") return;
    const event = baseEvents.find((item) => item.id === released.eventId) ?? serverEvents.find((item) => item.id === released.eventId);
    if (!event) return;
    const vm = mode === "month" ? "day" : mode;
    let preview = previewFrom(
      released,
      originRef.current,
      vm,
      monday,
      gridRef.current,
      width,
      snapRef.current,
      gridDayKey,
      timeZone,
      crossDayRef.current.peeked,
    );
  const carrying = crossDayRef.current;
    const originKey = carrying.originDayKey || event.dayKey;
    if (vm === "day" && carrying.phase === "carrying") {
      const targetMinutes = isAllDayEvent(event, timeZone) ? 0 : Math.round((preview?.startHour ?? 0) * 60);
      const { state, effect } = crossDayRelease(
        carrying,
        surface,
        surface === "grid" ? targetMinutes : undefined,
        plan.active,
      );
      setCrossDay(state);
      if (effect.outcome === "cancel" || effect.outcome === "interrupted") {
        restoreCrossDayView(carrying.originDayKey, carrying.scrollMinutes);
        return;
      }
      if (surface !== "grid" || !preview) return;
      const targetDay = carrying.peeked && carrying.viewDayKey !== originKey ? carrying.viewDayKey : preview.dayKey;
      const saveHour = isAllDayEvent(event, timeZone) ? 0 : preview.startHour;
      preview = { ...preview, dayKey: targetDay, startHour: saveHour };
      if (effect.outcome === "cross-day-save") {
        const start = atHour(preview.dayKey, preview.startHour, timeZone);
        const end = isAllDayEvent(event, timeZone)
          ? atHour(preview.dayKey, 24, timeZone)
          : atHour(preview.dayKey, preview.startHour + (originRef.current?.duration ?? event.endHour - event.startHour), timeZone);
        if (!start || !end) return;
        if (plan.active && effect.stage) {
          stagePreview(event.id, preview);
          restoreCrossDayView(originKey, carrying.scrollMinutes);
          return;
        }
        if (event.fixed) {
          setOverlay({ kind: "fixed", id: event.id, start, end });
          restoreCrossDayView(originKey, carrying.scrollMinutes);
          return;
        }
        setAnchor(preview.dayKey);
        void saveQuick(event, start, end, false, { deferTray: true }).then((deferred) => {
          window.setTimeout(() => {
            restoreCrossDayView(originKey, carrying.scrollMinutes);
            window.setTimeout(() => {
              if (!deferred) return;
              setTraySaveMessage(deferred.line);
              setTrayTargetDay(deferred.targetDay);
              setTrayMovedId(event.id);
              if (deferred.undo) setTraySaveUndo(() => deferred.undo!);
              pushToast(deferred.line, deferred.undo ?? undefined);
            }, 150);
          }, 300);
        });
        return;
      }
    }
    if (!preview) return;
    const start = atHour(preview.dayKey, preview.startHour, timeZone);
    const end = atHour(preview.dayKey, preview.startHour + (originRef.current?.duration ?? event.endHour - event.startHour), timeZone);
    if (!start || !end || (start === event.start && end === event.end)) return;
    if (plan.active) {
      stagePreview(event.id, preview);
      return;
    }
    if (event.fixed) {
      setOverlay({ kind: "fixed", id: event.id, start, end });
      return;
    }
    void saveQuick(event, start, end);
  }

  function blockUnder(x: number, y: number): CalEvent | null {
    const grid = gridRef.current;
    if (!grid) return null;
    const nodes = grid.querySelectorAll<HTMLElement>(".block");
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const rect = nodes[index].getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const id = nodes[index].dataset.testid?.slice("block-".length);
      return baseEvents.find((item) => item.id === id) ?? null;
    }
    return null;
  }

  function trackPan(pointerId: number, originY: number) {
    const grid = gridRef.current;
    if (!grid) return;
    const scroller = grid;
    const startScroll = scroller.scrollTop;
    function move(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      scroller.scrollTop = startScroll - (native.clientY - originY);
    }
    function up(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function startGesture(event: CalEvent, pointer: { pointerId: number; clientX: number; clientY: number; pointerType: string }) {
    if (gestureRef.current.phase !== "idle" && gestureRef.current.pointerId === pointer.pointerId) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-testid="block-${event.id}"]`)?.focus({ preventScroll: true });
    originRef.current = {
      id: event.id,
      startHour: event.startHour,
      duration: event.endHour - event.startHour,
      dayIndex: weekKeys.indexOf(event.dayKey),
      dayKey: event.dayKey,
    };
    snapRef.current = event.startHour;
    const next = gestureDown(pointer.pointerId, event.id, { x: pointer.clientX, y: pointer.clientY }, performance.now());
    gestureRef.current = next;
    setGesture(next);
    if (tip) setTip(false);
    const pointerId = pointer.pointerId;
    const touch = pointer.pointerType === "touch";
    let panning = false;
    let panOriginY = pointer.clientY;
    let panScroll = gridRef.current?.scrollTop ?? 0;
    function move(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      if (panning) {
        if (gridRef.current) gridRef.current.scrollTop = panScroll - (native.clientY - panOriginY);
        return;
      }
      const current = gestureRef.current;
      const updated = gestureMove(current, { x: native.clientX, y: native.clientY }, performance.now());
      if (touch && current.phase === "pending" && updated.phase === "idle") {
        panning = true;
        panOriginY = current.origin.y;
        panScroll = gridRef.current?.scrollTop ?? 0;
        gestureRef.current = updated;
        if (gridRef.current) gridRef.current.scrollTop = panScroll - (native.clientY - panOriginY);
        flushSync(() => setGesture(updated));
        return;
      }
      if (updated.phase === "lifted" && current.phase !== "lifted" && mode === "day" && originRef.current) {
        const grid = gridRef.current;
        setCrossDay(crossDayLift(originRef.current.id, originRef.current.dayKey, (grid?.scrollTop ?? 0) / PX_PER_MINUTE));
      }
      if (updated.phase === "lifted" && mode === "day") {
        const stripEl = document.querySelector('[data-testid="day-strip"]');
        if (stripEl instanceof HTMLElement) {
          const rect = stripEl.getBoundingClientRect();
          if (native.clientY >= rect.top && native.clientY <= rect.bottom) {
            setCrossDay((state) => {
              let next = state.phase === "carrying" ? crossDayStripEnter(state) : state;
              for (const key of weekKeys) {
                const cell = stripEl.querySelector<HTMLElement>(`[data-strip-key="${key}"]`);
                if (!cell) continue;
                const box = cell.getBoundingClientRect();
                if (native.clientX >= box.left && native.clientX <= box.right) {
                  next = crossDayHoverCell(next, key);
                  break;
                }
              }
              return next;
            });
          } else {
            setCrossDay((state) => (state.onStrip ? crossDayStripLeave(state) : state));
          }
        }
        const grid = gridRef.current;
        const topZone = document.querySelector('[data-testid="autoscroll-zone-top"]');
        const bottomZone = document.querySelector('[data-testid="autoscroll-zone-bottom"]');
        const stamp = performance.now();
        let zone: "top" | "bottom" | null = null;
        if (topZone instanceof HTMLElement) {
          const box = topZone.getBoundingClientRect();
          if (native.clientY >= box.top && native.clientY <= box.bottom) zone = "top";
        }
        if (!zone && bottomZone instanceof HTMLElement) {
          const box = bottomZone.getBoundingClientRect();
          if (native.clientY >= box.top && native.clientY <= box.bottom) zone = "bottom";
        }
        if (zone !== autoScrollRef.current.zone) autoScrollRef.current = { zone, since: stamp };
        if (grid && zone && stamp - autoScrollRef.current.since >= 400) {
          if (zone === "top") {
            grid.scrollTop = Math.max(0, grid.scrollTop - 8);
          } else {
            const maxScroll = Math.max(0, grid.scrollHeight - grid.clientHeight);
            const nextDay = grid.querySelector('[data-testid="next-day-link"]');
            const gridBox = grid.getBoundingClientRect();
            const stop = nextDay instanceof HTMLElement && nextDay.getBoundingClientRect().top <= gridBox.bottom + 2;
            if (!stop) grid.scrollTop = Math.min(maxScroll, grid.scrollTop + 8);
          }
        }
      }
      gestureRef.current = updated;
      flushSync(() => setGesture(updated));
    }
    function up(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (panning) {
        gestureRef.current = { phase: "idle" };
        setGesture({ phase: "idle" });
        return;
      }
      autoScrollRef.current = { zone: null, since: 0 };
      const carryingUp = crossDayRef.current;
      if (native.type === "pointercancel" && carryingUp.phase === "carrying") {
        setCrossDay(crossDayInterrupt(carryingUp).state);
        restoreCrossDayView(carryingUp.originDayKey, carryingUp.scrollMinutes);
        gestureRef.current = { phase: "idle" };
        setGesture({ phase: "idle" });
        return;
      }
      const surface = crossDaySurfaceAt(native.clientX, native.clientY);
      const current = gestureRef.current;
      const point = current.phase === "idle"
        ? { x: native.clientX, y: native.clientY }
        : current.point;
      const released = gestureMove(current, point, performance.now());
      const result = gestureUp(released);
      if (native.type !== "pointercancel" && result.tap) {
        const eventId = event.id;
        let sawClick = false;
        const note = () => { sawClick = true; };
        window.addEventListener("click", note, true);
        window.setTimeout(() => {
          window.removeEventListener("click", note, true);
          if (sawClick) return;
          setOverlay({ kind: "event", id: eventId });
        }, 80);
      }
      if (released.phase === "lifted" && carryingUp.phase === "carrying" && surface === "strip") {
        setCrossDay((state) => (state.phase === "carrying" ? crossDayStripEnter(state) : state));
        gestureRef.current = { phase: "idle" };
        setGesture({ phase: "idle" });
        return;
      }
      if (released.phase === "lifted" && carryingUp.phase === "carrying" && (surface !== "grid" || !result.commit)) {
        finishGesture(released, surface);
        gestureRef.current = { phase: "idle" };
        setGesture({ phase: "idle" });
        return;
      }
      if (result.commit && released.phase === "lifted") {
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 100);
        const face = gridRef.current?.querySelector(`[data-testid="block-${released.eventId}"] .face`);
        if (face instanceof HTMLElement) {
          const rect = face.getBoundingClientRect();
          settleFrom.current = { id: released.eventId, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
        setLockId(released.eventId);
        finishGesture(released, surface);
      }
      gestureRef.current = { phase: "idle" };
      setGesture({ phase: "idle" });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onGridPointerDown(pointer: React.PointerEvent<HTMLDivElement>) {
    if (pointer.button !== 0) return;
    if (crossDayRef.current.phase === "carrying" && crossDayRef.current.peeked) {
      if (resumeCrossDayPointerDrag(pointer)) return;
    }
  const hit = blockUnder(pointer.clientX, pointer.clientY);
    if (hit) {
      if (traySaveMessage) {
        setTraySaveMessage(null);
        setTrayTargetDay(null);
      }
      startGesture(hit, pointer);
      return;
    }
    const target = pointer.target;
    if (target instanceof Element && target.closest(".block, .slim")) return;
    const grid = gridRef.current;
    if (grid && gesture.phase !== "lifted") {
      const rect = grid.getBoundingClientRect();
      if (pager.onPagerPointerDown(pointer, rect.left, grid.scrollTop)) return;
    }
    if (pointer.pointerType === "touch" && gesture.phase !== "lifted") trackPan(pointer.pointerId, pointer.clientY);
  }

  function onPointerDown(event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) {
    if (pointer.button !== 0) return;
    if (isMultiDayEvent(event, timeZone)) {
      const pointerId = pointer.pointerId;
      const down = performance.now();
      let moved = false;
      const holdTimer = window.setTimeout(() => {
        if (!moved) openEvent(event);
      }, HOLD_MS);
      function move(native: PointerEvent) {
        if (native.pointerId !== pointerId) return;
        if (Math.hypot(native.clientX - pointer.clientX, native.clientY - pointer.clientY) > 8) {
          moved = true;
          window.clearTimeout(holdTimer);
        }
      }
      function up(native: PointerEvent) {
        if (native.pointerId !== pointerId) return;
        window.clearTimeout(holdTimer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (native.type !== "pointercancel" && !moved && performance.now() - down < HOLD_MS) openEvent(event);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return;
    }
    startGesture(event, pointer);
  }

  function onTrayPointer(pointer: React.PointerEvent<HTMLButtonElement>) {
    if (pointer.button !== 0) return;
    const found = document.querySelector(".tray-sheet");
    if (!(found instanceof HTMLElement)) return;
    const sheet = found;
    const height = sheet.getBoundingClientRect().height || 1;
    const startY = pointer.clientY;
    const pointerId = pointer.pointerId;
    const opened = trayOpen;
    const origin = opened ? 0 : height;
    let lastY = startY;
    let lastT = performance.now();
    let velocity = 0;
    sheet.style.transition = "none";
    function place(y: number) {
      const offset = Math.min(height, Math.max(0, origin + (y - startY)));
      sheet.style.transform = `translateY(${offset}px)`;
    }
    function move(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0) velocity = (native.clientY - lastY) / dt;
      lastY = native.clientY;
      lastT = now;
      place(native.clientY);
    }
    function finish(native: PointerEvent) {
      if (native.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const dy = native.clientY - startY;
      const offset = Math.min(height, Math.max(0, origin + dy));
      let open = opened;
      if (velocity < -0.4 || dy <= -24) open = true;
      else if (velocity > 0.4 || dy >= 24) open = false;
      else if (Math.abs(dy) < 8) open = !opened;
      else open = offset < height * 0.5;
      sheet.style.transition = "";
      sheet.style.transform = "";
      setTrayOpen(open);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    place(startY);
  }

  function nudge(event: CalEvent, minutes: number, days: number) {
    const span = PlanMachine.nudge(event.start, event.end, minutes, days, timeZone);
    if (!span) return;
    if (plan.active) {
      const server = serverEvents.find((item) => item.id === event.id);
      if (!server) return;
      const existing = plan.moves.find((item) => item.id === event.id);
      setPlan((current) => stageMove(current, stagedMove(
        server,
        { start: span.starts_at, end: span.ends_at },
        PlanTime.dayKey(new Date(span.starts_at), timeZone),
        existing,
      )));
      return;
    }
    if (event.fixed) {
      setOverlay({ kind: "fixed", id: event.id, start: span.starts_at, end: span.ends_at });
      return;
    }
    void saveQuick(event, span.starts_at, span.ends_at);
  }

  function onBlockKey(event: CalEvent, key: React.KeyboardEvent) {
    const minutes = key.key === "ArrowDown" ? 15 : key.key === "ArrowUp" ? -15 : 0;
    const days = key.key === "ArrowRight" ? 1 : key.key === "ArrowLeft" ? -1 : 0;
    if (!minutes && !days) return;
    key.preventDefault();
    if (key.repeat) return;
    nudge(event, minutes, days);
  }

  async function approveAll() {
    if (busy || approving.current || approveDisabled(plan.moves.length, included.length)) return;
    approving.current = true;
    const blocked = new Set(conflictIds);
    const moves: PlanMoveInput[] = [];
    const approvals: PlanApprovalInput[] = [];
    const sent = new Set<string>();
    for (const move of plan.moves) {
      if (blocked.has(move.id)) continue;
      const event = serverEvents.find((item) => item.id === move.id);
      const proposal = props.proposals.find((item) => item.id === move.id);
      const times = proposal ? proposalTimes(proposal) : null;
      const retry = Boolean(
        move.kind === "proposal"
        && proposal?.status === "approved"
        && times?.starts_at
        && times.ends_at
        && sameInstant(times.starts_at, move.to.start)
        && sameInstant(times.ends_at, move.to.end),
      );
      if (event?.kind === "proposal" || retry) {
        approvals.push({
          proposalId: move.id,
          expectedVersion: move.version,
          startsAt: move.to.start,
          endsAt: move.to.end,
        });
        sent.add(move.id);
        continue;
      }
      if (!event) continue;
      moves.push({
        blockId: event.id,
        expectedVersion: move.version,
        startsAt: move.to.start,
        endsAt: move.to.end,
        idempotencyKey: move.key,
        title: move.title || event.title,
        acknowledgeFixedMove: event.fixed,
      });
      sent.add(move.id);
    }
    const missing = plan.moves.filter((move) => !blocked.has(move.id) && !sent.has(move.id));
    for (const id of included) {
      if (approvals.some((item) => item.proposalId === id)) continue;
      const event = serverEvents.find((item) => item.id === id);
      if (!event) continue;
      approvals.push({ proposalId: id, expectedVersion: event.version });
    }
    if (moves.length === 0 && approvals.length === 0) {
      approving.current = false;
      setOverlay(null);
      pushToast(conflictText ? `${conflictText} changed, so nothing was saved.` : "Nothing to approve.");
      return;
    }
    setBusyFlag(true);
    try {
      const committed = await calendar.commitPlan({ moves, approvals });
      const savedIds = new Set(
        [...committed.moves, ...committed.approvals].filter((item) => item.saved).map((item) => item.id),
      );
      const unsavedIds = plan.moves.filter((move) => !savedIds.has(move.id)).map((move) => move.id);
      const kept = retainMoves(plan, unsavedIds);
      savePlan(kept);
      setPlan(kept);
      setOverrides({});
      setOverlay(null);
      const stagedIds = new Set(plan.moves.map((move) => move.id));
      const savedMoves = [...committed.moves, ...committed.approvals].filter((item) => item.saved && stagedIds.has(item.id)).length;
      const savedProposals = committed.approvals.filter((item) => item.saved && !stagedIds.has(item.id)).length;
      const unsavedTitles = [
        ...committed.moves.filter((item) => !item.saved).map((item) => item.title || "A move"),
        ...committed.approvals.filter((item) => !item.saved).map((item) => plan.moves.find((move) => move.id === item.id)?.title || item.title || "A proposal"),
        ...missing.map((move) => move.title),
      ];
      const confirmed = committed.confirmed;
      const held = plan.moves.filter((move) => blocked.has(move.id)).map((move) => move.title);
      const savedNote = unsavedTitles.length > 0
        ? partialPlanToast(savedMoves + savedProposals, savedMoves + savedProposals + unsavedTitles.length, unsavedTitles)
        : confirmed
          ? approvedToast(savedMoves, savedProposals, held)
          : SAVED_REFRESH;
      const message = unsavedTitles.length > 0 && held.length > 0 ? `${savedNote} · ${held.join(", ")} changed` : savedNote;
      if (savedMoves + savedProposals > 0) {
        glowIds([...committed.moves, ...committed.approvals].filter((item) => item.saved).map((item) => item.id));
      }
      const failedWrites = [...committed.moves, ...committed.approvals].flatMap((item) => {
        const outboxId = item.outbox?.id;
        if (item.saved || !outboxId) return [];
        const move = plan.moves.find((entry) => entry.id === item.id);
        const proposal = props.proposals.find((entry) => entry.id === item.id);
        const proposalSpan = proposal ? proposalTimes(proposal) : null;
        const start = move?.to.start || proposalSpan?.starts_at;
        const end = move?.to.end || proposalSpan?.ends_at;
        if (!start || !end) return [];
        const title = move?.title || item.title || "A move";
        const proposalWrite = move?.kind === "proposal" || (!move && Boolean(proposal));
        const missed = proposalWrite ? unplacedToast(title) : refusedMoveToast(title);
        return [{ outboxId, title, start, end, missed, eventId: item.id }];
      });
      const retryFailed = failedWrites.length
        ? async () => {
            for (const item of failedWrites) {
              await retryRefused(item.outboxId, item.title, item.start, item.end, item.missed, item.eventId);
            }
          }
        : undefined;
      pushToast(message, undefined, retryFailed);
      if (confirmed) await propsRef.current.onRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") setOverlay(null);
      await fail(error);
    } finally {
      approving.current = false;
      setBusyFlag(false);
    }
  }

  async function decide(event: CalEvent, action: "approve" | "deny") {
    const proposal = props.proposals.find((item) => item.id === event.id);
    if (!proposal || busy) return;
    setBusyFlag(true);
    try {
      if (action === "deny") {
        await calendar.decide(proposal, "deny");
        pushToast(denyToast(event.title));
      } else {
        const saved = await calendar.decide(proposal, "approve");
        const times = proposalTimes(proposal);
        if (!times.starts_at || !times.ends_at || !calendarWriteLanded(saved, times.starts_at, times.ends_at)) {
          const outboxId = saved.outbox?.id;
          const missed = unplacedToast(event.title);
          setOverlay(null);
          try {
            await propsRef.current.onRefresh();
          } catch {
            /* The approval is on the server. The next poll draws it. */
          }
          pushToast(
            missed,
            undefined,
            outboxId ? () => retryRefused(outboxId, event.title, times.starts_at || event.start, times.ends_at || event.end, missed, event.id) : undefined,
          );
          return;
        }
        pushToast(`Approved ${event.title}`);
        glowIds([event.id]);
      }
      setOverlay(null);
      await propsRef.current.onRefresh();
    } catch (error) {
      await fail(error);
    } finally {
      setBusyFlag(false);
    }
  }

  function openPlan() {
    setPlan(enterPlan());
    setOverlay(null);
    setTip(false);
  }

  function revertAll() {
    const stranded = plan.moves.flatMap((move) => {
      if (move.kind !== "proposal") return [];
      const proposal = props.proposals.find((item) => item.id === move.id);
      if (!proposal || proposal.status !== "approved") return [];
      const times = proposalTimes(proposal);
      const taskId = String((proposal.edited_payload || proposal.payload).task_id || "");
      const landed = props.blocks.some((block) => (
        block.status === "scheduled"
        && (block.task_id || "") === taskId
        && sameInstant(block.starts_at, move.to.start)
        && sameInstant(block.ends_at, move.to.end)
      ));
      return landed || !times.starts_at ? [] : [move.title];
    });
    const ids = plan.moves.map((move) => move.id);
    setPlan(exitPlan());
    setOverlay(null);
    glowIds(ids);
    pushToast(revertToast(stranded));
  }

  const lifted = gesture.phase === "lifted";
  const crossing = dragPreview ? crossingFor(dragPreview, serverEvents) : false;
  const liveParts = dragPreview ? readoutParts(dragPreview, serverEvents) : null;
  const layout = frame ? "frame" : "flow";
  const sheetOpen = overlay != null && overlay.kind !== "menu" && overlay.kind !== "view";
  const syncText = props.meta?.calendar_mode === "demo" ? SYNC_DEMO : props.meta?.sync_label || SYNC_DEMO;
  const framedClock = document.documentElement.dataset.frame === "1";

  return (
    <div
      className="v3"
      data-layout={layout}
      data-mode={mode}
      data-plan={plan.active ? "on" : "off"}
      data-sheet={sheetOpen ? "1" : "0"}
      data-toast={toast && !sheetOpen ? "1" : "0"}
      data-narrow={weekColumnWidth(Math.max(width, 320)) < 52 ? "1" : "0"}
    >
      <StatusBar framed={framedClock} time={now} timeZone={timeZone} />
      {plan.active ? (
        <PlanBanner
          count={plan.moves.length}
          suggestions={rangeIds.length}
          text={banner}
          live={lifted && liveParts != null}
          liveTitle={liveParts?.title ?? ""}
          liveWhen={liveParts?.when ?? ""}
          crossing={lifted && crossing}
          conflict={conflictLabel}
          compact={width < 380}
          onExit={() => { setPlan(exitPlan()); setOverlay(null); }}
          onRevert={() => setOverlay({ kind: "revert" })}
          onReview={() => setOverlay({ kind: "review" })}
        />
      ) : (
        <header className="v3-header">
          <button type="button" className="a11y-nav" data-testid="a11y-previous-day" aria-label="Previous day" onClick={() => setAnchor(PlanTime.addDaysToKey(anchor, -1))}>‹</button>
          <button type="button" className="title-jump" data-testid="day-title-jump" onClick={() => { setMonthAnchor(anchor); setOverlay({ kind: "jump" }); }}>
            <h1>{mode === "month" ? dayTitle(monthAnchor).replace(/,.*/, "") : mode === "day" ? dayTitle(gridDayKey) : weekTitle(monday)}</h1>
          </button>
          {crossDay.phase === "carrying" || gesture.phase === "lifted" ? (
            <span className="cross-day-chip" data-testid="cross-day-chip">{dayTitle(gridDayKey)}</span>
          ) : null}
          <CrossDayBanner originDayKey={crossDay.originDayKey || anchor} viewDayKey={crossDay.viewDayKey || gridDayKey} />
          <ReentryHint show={crossDay.phase === "carrying" && crossDay.hoverDayKey === crossDay.originDayKey && crossDay.onStrip} originDayKey={crossDay.originDayKey || anchor} />
          <button type="button" className="a11y-nav" data-testid="a11y-next-day" aria-label="Next day" onClick={() => setAnchor(PlanTime.addDaysToKey(anchor, 1))}>›</button>
          <button type="button" className="icon-btn" data-testid="plan-button" aria-label="Plan mode" title={PLAN_HINT} onClick={openPlan}>
            <PlanGlyph />
          </button>
          <button type="button" className="view-switch" data-testid="view-switch" aria-haspopup="menu" aria-expanded={overlay?.kind === "view"} onClick={() => setOverlay(overlay?.kind === "view" ? null : { kind: "view" })}>
            {mode === "month" ? "Month" : mode === "day" ? "Day" : "Week"} <Chevron />
          </button>
          <button type="button" className="icon-btn" data-testid="more-button" aria-label="More" aria-haspopup="menu" aria-expanded={overlay?.kind === "menu"} onClick={() => setOverlay(overlay?.kind === "menu" ? null : { kind: "menu" })}>
            <MoreGlyph />
          </button>
        </header>
      )}
      {mode === "day" ? (
        <div
          className="v3-dow"
          role="radiogroup"
          aria-label="Days"
          data-testid="day-strip"
          data-blocks-day-pager={overlay != null ? "1" : "0"}
          onPointerDownCapture={(event) => {
            if (event.button !== 0) return;
            const dayKey = stripDwellTargetFromPoint(event.clientX, event.clientY);
            if (dayKey) beginStripDwell(dayKey);
          }}
          onPointerUpCapture={(event) => {
            if (event.pointerType === "touch") return;
            stopStripDwell();
          }}
          onPointerCancelCapture={(event) => {
            if (event.pointerType === "touch") return;
            stopStripDwell();
          }}
          onTouchStartCapture={(event) => {
            const touch = event.changedTouches[0];
            if (!touch) return;
            const dayKey = stripDwellTargetFromPoint(touch.clientX, touch.clientY);
            if (dayKey) beginStripDwell(dayKey);
          }}
          onTouchEndCapture={() => stopStripDwell()}
          onTouchCancelCapture={() => stopStripDwell()}
        >
          {weekKeys.map((key) => {
            const proposed = serverEvents.some((event) => event.dayKey === key && event.state === "proposed");
            const selected = key === stripSelection;
            const today = key === todayKey;
            const hover = crossDay.hoverDayKey === key;
            const origin = crossDay.originDayKey === key && crossDay.phase === "carrying";
            return (
              <button
                key={key}
                type="button"
                className="day-pill strip-cell"
                role="radio"
                aria-checked={selected}
                data-testid={stripCellId(key)}
                aria-describedby={`strip-cell-${key}`}
                data-strip-key={key}
                data-today={today ? "1" : "0"}
                data-has-proposals={proposed ? "1" : "0"}
                onClick={(click) => {
                  if (crossDay.phase === "carrying") {
                    click.preventDefault();
                    return;
                  }
                  setAnchor(key);
                }}
                onPointerEnter={() => {
                  if (crossDay.phase === "carrying" && crossDay.onStrip) setCrossDay((s) => crossDayHoverCell(s, key));
                }}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key !== "ArrowRight" && keyEvent.key !== "ArrowLeft") return;
                  keyEvent.preventDefault();
                  const step = keyEvent.key === "ArrowRight" ? 1 : -1;
                  setAnchor(PlanTime.addDaysToKey(key, step));
                }}
              >
                <small>{dayName(key)}</small>
                <b className={today ? "today-underline" : ""}>{Number(key.slice(-2))}</b>
                {proposed ? <span data-testid={`strip-proposal-${dayName(key).toLowerCase()}`} data-has-proposals={proposed ? "1" : "0"}><Sparkle /></span> : null}
                {hover ? <DwellRing progress={dwellProgress(crossDay)} /> : null}
                {origin ? <i data-testid="strip-cell-origin-highlight" className="strip-origin-mark" /> : null}
                {crossDay.phase === "carrying" && key !== crossDay.originDayKey ? (
                  <i className="strip-drop-hint" data-testid={`strip-drop-hint-${dayName(key).toLowerCase()}`} />
                ) : null}
                <span hidden data-testid={`strip-cell-${key}`} />
              </button>
            );
          })}
        </div>
      ) : mode === "week" ? (
        <div
          className="v3-dow"
          data-testid="week-strip"
          data-week-offset={weekStripOffset === 0 ? "0" : weekStripOffset > 0 ? "+1" : "-1"}
          onPointerDown={(e) => {
            if (gesture.phase === "lifted") return;
            const startX = e.clientX;
            const pointerId = e.pointerId;
            function move(native: PointerEvent) {
              if (native.pointerId !== pointerId) return;
            }
            function up(native: PointerEvent) {
              if (native.pointerId !== pointerId) return;
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              const dx = native.clientX - startX;
              if (Math.abs(dx) > 40) setWeekStripOffset((o) => o + (dx < 0 ? 1 : -1));
            }
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          {weekKeys.map((key) => (
            <button key={key} type="button" className="week-head" data-testid={stripCellId(key)} data-today={key === todayKey} onClick={() => { setAnchor(key); setMode("day"); }}>
              <small>{dayName(key).slice(0, 1)}</small>
              <b>{Number(key.slice(-2))}</b>
            </button>
          ))}
        </div>
      ) : null}
      {mode === "month" ? (
        <div className="v3-month" data-testid="month-view">
          <MonthGridSheet
            anchorDayKey={monthAnchor}
            timeZone={timeZone}
            selectedDayKey={anchor}
            events={baseEvents.map((event) => ({ dayKey: event.dayKey, domain: event.domain }))}
            detent="large"
            onSelectDate={(key) => { setAnchor(key); setMonthAnchor(key); }}
            onOpenDay={(key) => { setAnchor(key); setMode("day"); }}
            onPrevMonth={() => setMonthAnchor(PlanTime.addDaysToKey(monthAnchor, -28))}
            onNextMonth={() => setMonthAnchor(PlanTime.addDaysToKey(monthAnchor, 28))}
            onToday={() => { const key = todayKey; setAnchor(key); setMonthAnchor(key); }}
          />
        </div>
      ) : (
      <>
      {mode === "day" ? (
        <>
          <div className="autoscroll-zone-top" data-testid="autoscroll-zone-top" aria-hidden />
          <div className="autoscroll-zone-bottom" data-testid="autoscroll-zone-bottom" data-above-tray={traySaveMessage && gesture.phase !== "lifted" ? "1" : "0"} aria-hidden />
        </>
      ) : null}
      <div
        className="v3-grid"
        ref={gridRef}
        data-testid={mode === "day" ? "day-grid" : "week-grid"}
        data-hour-px={mode === "day" ? DAY_PX : WEEK_PX}
        data-origin={mode === "day" ? DAY_ORIGIN : WEEK_ORIGIN}
        data-gutter={mode === "day" ? DAY_GUTTER : WEEK_GUTTER}
        data-scroll-hour={scrollHour}
        data-hour-count={mode === "day" ? String(dayRowsFor(gridDayKey, timeZone).length) : String(weekHourMax)}
        data-range="24h"
        data-bottom-inset-pt={traySaveMessage ? "48" : "0"}
        data-momentum="0"
        aria-busy={props.loading}
        onPointerDownCapture={onGridPointerDown}
        onScroll={(e) => {
          const node = e.currentTarget;
          node.dataset.momentum = node.scrollTop !== parseFloat(node.dataset.lastScroll || "0") ? "1" : "0";
          node.dataset.lastScroll = String(node.scrollTop);
        }}
      >
        {nowOffscreen && mode === "day" ? (
          <NowChip label={exactClock(nowHour)} onJump={() => {
            const grid = gridRef.current;
            if (grid) grid.scrollTop = nowHour * 60 * PX_PER_MINUTE - grid.clientHeight / 2;
          }} />
        ) : null}
        <div
          className="day-pager"
          data-testid={mode === "day" ? "day-pager" : "week-pager"}
          data-enabled={pager.dataEnabled}
          data-pan-kind={pager.panKind}
          data-a11y-paged="1"
          data-transition={reducedMotion ? "cross-fade" : "slide"}
          data-offset-px={String(pager.offsetX)}
          data-translate-x={!reducedMotion && pager.offsetX ? String(pager.offsetX) : undefined}
          style={!reducedMotion && pager.offsetX ? { transform: `translateX(${pager.offsetX}px)` } : undefined}
          onPointerDown={(e) => {
            const grid = gridRef.current;
            if (!grid) return;
            const rect = grid.getBoundingClientRect();
            if (pager.onPagerPointerDown(e, rect.left, grid.scrollTop)) e.stopPropagation();
          }}
        >
        <div className="grid-canvas" style={{ height: mode === "day" ? PlanTime.dayHeightPx(gridDayKey, timeZone) + 44 : weekGridHeightPx(weekKeys, timeZone) + 44 }}>
          {mode === "day" ? (
            <HourRows rows={dayRowsFor(gridDayKey, timeZone)} width={Math.max(width, 320)} mode="day" dayKey={gridDayKey} />
          ) : (
            <>
              <div
                className="week-hour-axis"
                data-testid="week-hour-axis"
                style={{ height: weekGridHeightPx(weekKeys, timeZone) }}
              >
                <HourRows rows={weekRowsFor(monday, timeZone)} width={Math.max(width, 320)} mode="week" />
              </div>
            </>
          )}
          {props.loading ? <div className="skeleton" aria-hidden="true"><i /><i /><i /></div> : null}
          {!props.loading && props.error && serverEvents.length === 0 ? (
            <div className="error-panel" role="alert">
              <p>{props.error}</p>
              <button type="button" onClick={() => props.onRefresh().catch(() => undefined)}>Retry</button>
            </div>
          ) : null}
          {!props.loading && !props.error && (mode === "day" ? dayEvents.length === 0 : weekEvents.length === 0) ? (
            <div className="empty">
              <p>{mode === "day" ? "Nothing on this day." : "Nothing this week."}</p>
              {loose.length > 0 ? <button type="button" onClick={() => setOverlay({ kind: "unscheduled" })}>Show unscheduled</button> : null}
            </div>
          ) : null}
          {mode === "day" && (allDayEvents.length > 0 || multiDayEvents.length > 0) ? (
            <AllDayRow
              allDay={allDayEvents}
              multiDay={multiDayEvents}
              timeZone={timeZone}
              onPointerDown={onPointerDown}
              onOpen={openEvent}
            />
          ) : null}
          {mode === "day" ? (
            <DayCanvas
              events={timedDayEvents}
              width={Math.max(width, 320)}
              nowHour={anchor === todayKey ? nowHour : null}
              drag={dragPreview}
              glow={glow}
              settle={settle}
              lockId={lockId}
              openId={overlay?.kind === "event" ? overlay.id : null}
              onPointerDown={onPointerDown}
              onKeyDown={onBlockKey}
              onOpen={openEvent}
              highlightId={crossHighlightId}
            />
          ) : (
            <WeekCanvas
              events={weekEvents}
              layoutEvents={baseEvents.filter((event) => weekKeys.includes(event.dayKey))}
              weekKeys={weekKeys}
              timeZone={timeZone}
              width={Math.max(width, 320)}
              nowHour={weekKeys.includes(todayKey) ? nowHour : null}
              todayIndex={weekKeys.indexOf(todayKey)}
              drag={dragPreview}
              glow={glow}
              settle={settle}
              lockId={lockId}
              openId={overlay?.kind === "event" ? overlay.id : null}
              onPointerDown={onPointerDown}
              onKeyDown={onBlockKey}
              onOpen={(event) => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setOverlay({ kind: "event", id: event.id });
              }}
            />
          )}
          {mode === "day" ? (
            <NextDayRow nextKey={PlanTime.addDaysToKey(gridDayKey, 1)} onOpen={() => setAnchor(PlanTime.addDaysToKey(gridDayKey, 1))} />
          ) : null}
        </div>
        </div>
      </div>
      </>
      )}
      {trayTargetDay ? (
        <i className="cross-day-target-dot" data-testid={`cross-day-target-dot-${dayName(trayTargetDay).toLowerCase()}`} aria-hidden />
      ) : null}
      {trayOpen ? <button type="button" className="tray-scrim" data-testid="tray-scrim" aria-label="Close tray" onClick={() => setTrayOpen(false)} /> : null}
      <div className="tray-sheet" data-open={trayOpen ? "1" : "0"} data-testid="tray-sheet" role="dialog" aria-label="Calendar tray" aria-hidden={trayOpen ? undefined : true}>
        <button type="button" className="tray-grip" data-testid="tray-sheet-grip" aria-label="Calendar tray" onPointerDown={onTrayPointer} />
        <div className="tray-sheet-body">
          <h2>Unscheduled</h2>
          <p className="sub">{loose.length === 0 ? "Everything is on the calendar." : "These tasks are not on the calendar yet."}</p>
          {loose.map((task) => (
            <div key={task.id} className="row">{task.title}</div>
          ))}
          <h2>{syncText}</h2>
          <p className="sub">{(props.meta?.sync_label || "").replaceAll("NOT synced", "Not synced")}</p>
        </div>
      </div>
      {traySaveMessage ? (
        <div className="tray-save-message" data-testid="tray-save-message" role="status">
          <button
            type="button"
            data-testid="tray-save-message-text"
            className="tray-save-text"
            onClick={() => {
              if (!trayTargetDay) return;
              const moved = baseEvents.find((item) => item.id === trayMovedId) ?? baseEvents.find((item) => item.dayKey === trayTargetDay);
              setAnchor(trayTargetDay);
              if (moved) {
                setCrossHighlightId(moved.id);
                const grid = gridRef.current;
                if (grid) {
                  grid.scrollTop = Math.max(0, moved.startHour * 60 * PX_PER_MINUTE - grid.clientHeight / 3);
                }
                window.setTimeout(() => setCrossHighlightId(null), 300);
              }
            }}
          >
            {traySaveMessage}
          </button>
          {traySaveUndo ? (
            <button type="button" onClick={() => { const run = traySaveUndo; setTraySaveUndo(null); setTraySaveMessage(null); void run(); }}>Undo</button>
          ) : undo ? (
            <button type="button" onClick={() => { const run = undo; setTraySaveMessage(null); setToast(null); setUndo(null); void run(); }}>Undo</button>
          ) : null}
        </div>
      ) : null}
      <div className="v3-tray">
        <button type="button" className="tray-grip" data-testid="tray-grip" aria-label="Calendar tray" onPointerDown={onTrayPointer} />
        <button type="button" className="unscheduled" data-testid="unscheduled" onClick={() => setTrayOpen(true)}>
          Unscheduled <b>{loose.length}</b>
        </button>
        <button type="button" className="sync-chip" data-testid="sync-chip" onClick={() => setTrayOpen(true)}>
          <i aria-hidden="true" /> {syncText}
        </button>
      </div>
      {tip && !plan.active ? (
        <div className="tip" style={{ left: 16 }} role="note">
          <i style={{ left: 184 }} aria-hidden="true" />
          <span>{TIP_TEXT}</span>
          <button type="button" aria-label="Dismiss tip" onClick={() => setTip(false)}>×</button>
        </div>
      ) : null}
      <div className="v3-toast-slot" aria-live="polite" aria-atomic="true" data-testid="live-region">
        <span className="v3-sr" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>{live}</span>
        {toast ? (
          <div className="toast" data-testid="plan-toast" role="status">
            <ToastIcon message={toast.message} />
            <ToastCopy message={toast.message} />
            {undo ? <button type="button" onClick={() => { const run = undo; setToast(null); setUndo(null); setRetry(null); void run(); }}>Undo</button> : null}
            {retry ? <button type="button" onClick={() => { const run = retry; setToast(null); setUndo(null); setRetry(null); void run(); }}>Retry</button> : null}
          </div>
        ) : null}
      </div>
      {overlay ? (
      <div className={sheetClosing ? "modal closing" : "modal"}>
      <div className="scrim" onClick={() => setOverlay(null)} />
      {overlay.kind === "view" ? (
        <div className="view-menu" role="menu" aria-label="Calendar view">
          <button type="button" role="menuitem" onClick={() => { setMode("day"); setOverlay(null); }}>Day</button>
          <button type="button" role="menuitem" onClick={() => { setMode("week"); setOverlay(null); }}>Week</button>
          <button type="button" role="menuitem" onClick={() => { setMode("month"); setMonthAnchor(anchor); setOverlay(null); }}>Month</button>
        </div>
      ) : null}
      {overlay.kind === "jump" ? (
        <div data-testid="jump-sheet" data-blocks-day-pager="1">
          <MonthGridSheet
            anchorDayKey={monthAnchor}
            timeZone={timeZone}
            selectedDayKey={anchor}
            events={baseEvents.map((event) => ({ dayKey: event.dayKey, domain: event.domain }))}
            detent="medium"
            onSelectDate={(key) => {
              if (overlay.kind === "jump" && overlay.moveEventId) {
                const event = serverEvents.find((item) => item.id === overlay.moveEventId);
                if (event) {
                  const start = atHour(key, event.startHour, timeZone);
                  const end = atHour(key, event.endHour, timeZone);
                  if (start && end) void saveQuick(event, start, end);
                }
                setOverlay(null);
                return;
              }
              setAnchor(key);
              setOverlay(null);
            }}
            onOpenDay={(key) => { setAnchor(key); setMode("day"); setOverlay(null); }}
            onPrevMonth={() => setMonthAnchor(PlanTime.addDaysToKey(monthAnchor, -28))}
            onNextMonth={() => setMonthAnchor(PlanTime.addDaysToKey(monthAnchor, 28))}
            onToday={() => { const key = todayKey; setAnchor(key); setOverlay(null); }}
          />
        </div>
      ) : null}
      {overlay.kind === "menu" ? (
        <div className="menu" role="menu" aria-label="More">
          <button type="button" role="menuitem" onClick={() => setOverlay({ kind: "search" })}><SearchGlyph /> Search</button>
          <button type="button" role="menuitem" className="tall" onClick={openPlan}><PlanGlyph /> <span>Plan mode<small>Move many, then approve or revert</small></span></button>
          <button type="button" role="menuitem" className="tall" onClick={() => setOverlay({ kind: "show" })}><span>Show…<small>{showSummary(filters)}</small></span></button>
          <button type="button" role="menuitem" onClick={() => setOverlay({ kind: "sync" })}>Sync: {syncText}</button>
          <button type="button" role="menuitem" onClick={() => setOverlay({ kind: "settings" })}>Settings</button>
        </div>
      ) : null}
      {overlay.kind === "show" ? <ShowSheet filters={filters} onChange={setFilters} /> : null}
      {overlay.kind === "search" ? (
        <SearchSheet events={visibleEvents(baseEvents, filters, query)} query={query} onQuery={setQuery} onPick={(event) => { setAnchor(event.dayKey); setMode("day"); setOverlay({ kind: "event", id: event.id }); }} />
      ) : null}
      {overlay.kind === "settings" ? <SettingsSheet meta={props.meta} /> : null}
      {overlay.kind === "sync" ? <SyncSheet meta={props.meta} text={syncText} /> : null}
      {overlay.kind === "unscheduled" ? <UnscheduledSheet tasks={loose} /> : null}
      {overlay.kind === "event" ? (
        <EventSheet
          event={events.find((item) => item.id === overlay.id) ?? serverEvents.find((item) => item.id === overlay.id) ?? null}
          onClose={() => setOverlay(null)}
          onDecide={decide}
          onRetry={(event) => {
            if (!event.outboxId) return;
            setOverlay(null);
            void retryRefused(event.outboxId, event.title, event.start, event.end, unplacedToast(event.title), event.id);
          }}
          onTime={() => pushToast("Drag the block to change the time.")}
          onDatePick={() => {
            setMonthAnchor(anchor);
            setOverlay({ kind: "jump", moveEventId: overlay.id });
          }}
        />
      ) : null}
      {overlay.kind === "review" ? (
        <ReviewSheet
          moves={plan.moves}
          events={serverEvents}
          proposals={serverEvents.filter((event) => event.state === "proposed" && !plan.moves.some((move) => move.id === event.id) && (mode === "day" ? event.dayKey === anchor : weekKeys.includes(event.dayKey)))}
          skipped={plan.skipped}
          timeZone={timeZone}
          onSkip={(id) => setPlan((current) => toggleSkip(current, id))}
          onApprove={() => void approveAll()}
          onKeep={() => setOverlay(null)}
          disabled={approveDisabled(plan.moves.length, included.length) || busy}
          label={approveLabel(plan.moves.length, included.length)}
          conflicts={conflictIds}
        />
      ) : null}
      {overlay.kind === "revert" ? (
        <RevertSheet count={plan.moves.length} proposals={rangeIds.length} onRevert={revertAll} onKeep={() => setOverlay(null)} />
      ) : null}
      {overlay.kind === "fixed" ? (
        <FixedSheet
          onCancel={() => setOverlay(null)}
          onMove={() => {
            const event = serverEvents.find((item) => item.id === overlay.id);
            setOverlay(null);
            if (event) void saveQuick(event, overlay.start, overlay.end, true);
          }}
        />
      ) : null}
      </div>
      ) : null}
      <span className="home-bar" aria-hidden="true" />
      <span hidden data-rev={TAFO_REV} data-testid="rev" />
    </div>
  );
}

function previewFrom(
  gesture: Gesture,
  origin: DragOrigin | null,
  mode: "day" | "week",
  monday: string,
  grid: HTMLDivElement | null,
  width: number,
  previousSnap: number | null,
  displayDayKey: string,
  timeZone: string,
  crossPeeking: boolean,
): Preview | null {
  if (gesture.phase !== "lifted" || !origin || !grid) return null;
  const rect = grid.getBoundingClientRect();
  const dayKey = mode === "day" ? (crossPeeking ? displayDayKey : origin.dayKey) : origin.dayKey;
  const scrollTop = grid.scrollTop;
  const originY = gesture.origin.y - rect.top + scrollTop;
  const pointY = gesture.point.y - rect.top + scrollTop;
  const moved = moveByPointer({
    originStart: origin.startHour,
    originDay: Math.max(0, origin.dayIndex),
    duration: origin.duration,
    deltaY: pointY - originY,
    pointerX: gesture.point.x - rect.left,
    pxPerHour: mode === "day" ? DAY_PX : WEEK_PX,
    gutter: mode === "day" ? DAY_GUTTER : WEEK_GUTTER,
    columnWidth: mode === "day" ? width : weekColumnWidth(width),
    allowDayChange: mode === "week",
    previousSnap,
    dayKey,
    timeZone,
  });
  if (Math.hypot(gesture.point.x - gesture.origin.x, gesture.point.y - gesture.origin.y) < COMMIT_PX) return null;
  return {
    id: origin.id,
    dayIndex: moved.day,
    dayKey: mode === "week" ? PlanTime.addDaysToKey(monday, moved.day) : dayKey,
    startHour: moved.start,
  };
}

function crossingFor(preview: Preview, events: CalEvent[]): boolean {
  const event = events.find((item) => item.id === preview.id);
  if (!event) return false;
  const end = preview.startHour + (event.endHour - event.startHour);
  return crossesWorkHours(event.domain, PlanTime.weekdayIndex(event.dayKey), event.startHour, event.endHour, preview.dayIndex, preview.startHour, end);
}

function readoutParts(preview: Preview, events: CalEvent[]): { title: string; when: string } | null {
  const event = events.find((item) => item.id === preview.id);
  if (!event) return null;
  const end = preview.startHour + (event.endHour - event.startHour);
  return { title: event.title, when: `${dayName(preview.dayKey)} ${rangeLabel(preview.startHour, end)}` };
}

function StatusBar({ framed, time, timeZone }: { framed: boolean; time: Date; timeZone: string }) {
  const part = PlanTime.parts(time, timeZone);
  const label = framed ? "9:41" : `${part.hour % 12 || 12}:${String(part.minute).padStart(2, "0")}`;
  return (
    <div className="v3-status" aria-hidden="true">
      <span>{label}</span>
      <svg width="68" height="14" viewBox="0 0 68 14">
        <rect x="0" y="8" width="3" height="4" rx="0.6" fill="#EDEEF0" />
        <rect x="5" y="6" width="3" height="6" rx="0.6" fill="#EDEEF0" />
        <rect x="10" y="4" width="3" height="8" rx="0.6" fill="#EDEEF0" />
        <rect x="15" y="2" width="3" height="10" rx="0.6" fill="#EDEEF0" />
        <path d="M28 4.5c3.2-2.6 8.2-2.6 11.4 0" fill="none" stroke="#EDEEF0" strokeWidth="1.4" />
        <path d="M30.4 7.2c1.8-1.4 4.6-1.4 6.4 0" fill="none" stroke="#EDEEF0" strokeWidth="1.4" />
        <circle cx="33.6" cy="10.2" r="1.1" fill="#EDEEF0" />
        <rect x="46" y="2" width="18" height="10" rx="2" fill="none" stroke="#A3A8B0" />
        <rect x="48" y="4" width="12" height="6" rx="1" fill="#EDEEF0" />
      </svg>
    </div>
  );
}

function toastKind(message: string): "info" | "plain" | "ok" {
  if (
    message.includes("still in plan")
    || message.includes(" changed")
    || message.includes("didn't move")
    || message.includes("not on calendar")
  ) return "info";
  if (message.startsWith("Reverted") || message.startsWith("Denied")) return "plain";
  return "ok";
}

function ToastIcon(props: { message: string }) {
  const kind = toastKind(props.message);
  return (
    <span className={kind === "ok" ? "toast-icon" : `toast-icon ${kind}`} data-icon={kind} aria-hidden="true">
      {kind === "info" ? <InfoGlyph /> : <CheckGlyph />}
    </span>
  );
}

const STATUS_TAILS = [" still in plan", " not on calendar", " changed"];

function toastParts(message: string): { count: string; name: string; keep: string } | null {
  if (message.includes("changed, so nothing was saved")) return null;
  const tail = STATUS_TAILS.find((item) => message.endsWith(item));
  if (!tail) return null;
  const head = message.slice(0, -tail.length);
  const dot = head.lastIndexOf(" · ");
  if (dot < 0) return { count: "", name: head.trim(), keep: tail };
  const left = head.slice(0, dot).trim();
  const right = head.slice(dot + 3).trim();
  if (!right) return { count: "", name: left, keep: ` ·${tail}` };
  return { count: `${left} · `, name: right, keep: tail };
}

function ToastCopy(props: { message: string }) {
  const parts = toastParts(props.message);
  if (!parts) return <p>{props.message}</p>;
  return (
    <p className="partial-line">
      {parts.count ? <span className="partial-count">{parts.count}</span> : null}
      {parts.name ? <span className="partial-name">{parts.name}</span> : null}
      <span className="partial-keep" data-testid="toast-keep">{parts.keep}</span>
    </p>
  );
}

function PlanBanner(props: {
  count: number;
  suggestions: number;
  text: string;
  live: boolean;
  liveTitle: string;
  liveWhen: string;
  crossing: boolean;
  conflict: string;
  compact: boolean;
  onExit: () => void;
  onRevert: () => void;
  onReview: () => void;
}) {
  return (
    <div className="v3-banner" data-testid="plan-banner">
      <PlanGlyph />
      <div className="banner-copy">
        <h1>Plan mode</h1>
        {props.live ? (
          <p className="banner-live">
            <span className="banner-title">{props.liveTitle}</span>
            <span className="banner-when"> · {props.liveWhen}</span>
          </p>
        ) : props.conflict && props.compact ? (
          <p data-testid="plan-conflict">{props.conflict}</p>
        ) : <p>{props.text}</p>}
        {props.conflict && !props.compact ? <p data-testid="plan-conflict">{props.conflict}</p> : null}
      </div>
      {props.live && props.crossing ? <span className="tag">Crosses work hours</span> : null}
      {!props.live && props.count === 0 && props.suggestions === 0 ? <button type="button" className="ghost-btn" onClick={props.onExit}>Exit</button> : null}
      {!props.live && props.count === 0 && props.suggestions > 0 ? (
        <div className="banner-actions">
          <button type="button" className="ghost-btn" onClick={props.onExit}>Exit</button>
          <button type="button" className="solid-btn" onClick={props.onReview}>Review</button>
        </div>
      ) : null}
      {!props.live && props.count > 0 ? (
        <div className="banner-actions">
          <button type="button" className="ghost-btn" onClick={props.onRevert}>Revert</button>
          <button type="button" className="solid-btn" onClick={props.onReview}>Review</button>
        </div>
      ) : null}
    </div>
  );
}

const WEEK_FACE_REST: React.CSSProperties = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: "auto",
  height: "auto",
};

function settleMotion(settle: Settle | null, id: string): { className: string; style: React.CSSProperties } {
  if (!settle || settle.id !== id) return { className: "", style: {} };
  const box = settle.live ? settle.rest : settle.park;
  if (!box) return { className: "settling live", style: {} };
  return {
    className: settle.live ? "settling live" : "settling",
    style: {
      position: "absolute",
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      right: "auto",
      bottom: "auto",
    },
  };
}

function calendarWriteLanded(
  saved: { outbox: { status?: string } | null; block: { starts_at: string; ends_at: string } | null },
  start: string,
  end: string,
): boolean {
  const status = saved.outbox?.status;
  if (status !== "simulated" && status !== "synced") return false;
  if (!saved.block) return false;
  return sameInstant(saved.block.starts_at, start) && sameInstant(saved.block.ends_at, end);
}

function proposalTimes(proposal: Proposal): { status: string; starts_at?: string; ends_at?: string } {
  const edited = proposal.edited_payload;
  const source = edited && typeof edited.starts_at === "string" ? edited : proposal.payload;
  return {
    status: proposal.status,
    starts_at: typeof source.starts_at === "string" ? source.starts_at : undefined,
    ends_at: typeof source.ends_at === "string" ? source.ends_at : undefined,
  };
}

function AllDayRow(props: {
  allDay: CalEvent[];
  multiDay: CalEvent[];
  timeZone: string;
  onPointerDown: (event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) => void;
  onOpen: (event: CalEvent) => void;
}) {
  return (
    <div className="all-day-row" data-testid="all-day-row">
      {props.allDay.map((event) => (
        <button
          key={event.id}
          type="button"
          className="all-day-chip block"
          data-testid={`block-${event.id}`}
          aria-label={eventLabel(event)}
          onPointerDown={(pointer) => props.onPointerDown(event, pointer)}
          onClick={() => props.onOpen(event)}
        >
          {event.title}
        </button>
      ))}
      {props.multiDay.map((event) => (
        <button
          key={event.id}
          type="button"
          className="all-day-chip block"
          data-testid={`block-${event.id}`}
          data-draggable="0"
          aria-label={multiDayLabel(event, props.timeZone)}
          onPointerDown={(pointer) => props.onPointerDown(event, pointer)}
          onClick={() => props.onOpen(event)}
        >
          {multiDayLabel(event, props.timeZone)}
        </button>
      ))}
    </div>
  );
}

function DayCanvas(props: {
  events: CalEvent[];
  width: number;
  nowHour: number | null;
  drag: Preview | null;
  glow: string[];
  settle: Settle | null;
  lockId: string | null;
  openId: string | null;
  highlightId: string | null;
  onPointerDown: (event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: CalEvent, key: React.KeyboardEvent) => void;
  onOpen: (event: CalEvent) => void;
}) {
  const timed = props.events.map((event) => ({ id: event.id, start: event.startHour, end: event.endHour }));
  const boxes = dayBoxes(timed, props.width);
  const taps = dayTaps(timed, props.width);
  const markY = props.drag ? dayY(props.drag.startHour) : null;
  return (
    <>
      <div className="workband" style={{ left: DAY_GUTTER, top: dayY(9), right: 0, height: dayY(17) - dayY(9) }} />
      <div className="work-end" style={{ top: dayY(17) - 4 }}>Work hours end</div>
      {props.drag ? <div className="ghost" style={ghostStyle(boxes.find((box) => box.id === props.drag?.id))} /> : null}
      {props.events.map((event) => {
        const box = boxes.find((item) => item.id === event.id);
        const tap = taps.find((item) => item.id === event.id);
        if (!box || !tap) return null;
        const lifted = props.drag?.id === event.id;
        const shift = lifted && props.drag ? dayY(props.drag.startHour) - dayY(event.startHour) : 0;
        const movedBox = shift === 0 ? box : { ...box, y: box.y + shift };
        const movedTap = shift === 0 ? tap : { ...tap, y: tap.y + shift };
        const shown = lifted && props.drag
          ? { ...event, startHour: props.drag.startHour, endHour: props.drag.startHour + (event.endHour - event.startHour) }
          : event;
        return (
          <EventButton
            key={event.id}
            event={shown}
            box={movedBox}
            tap={movedTap}
            lifted={lifted}
            open={props.openId === event.id}
            glow={props.glow.includes(event.id)}
            settle={props.settle}
            lockId={props.lockId}
            highlight={props.highlightId === event.id ? "cross-day" : undefined}
            onPointerDown={props.onPointerDown}
            onKeyDown={props.onKeyDown}
            onOpen={props.onOpen}
          />
        );
      })}
      {props.nowHour != null ? <NowMark hour={props.nowHour} left={DAY_GUTTER} width={props.width - DAY_GUTTER} hidePill={hideNowPill(markY, dayY(props.nowHour), 11, 8)} /> : null}
      {props.drag ? <DayPill hour={props.drag.startHour} blockX={boxes.find((box) => box.id === props.drag?.id)?.x ?? DAY_GUTTER} data-testid="gutter-drag-pill" /> : null}
    </>
  );
}

function hideNowPill(markY: number | null, nowY: number, markHalf: number, nowHalf: number): boolean {
  if (markY == null) return false;
  return Math.abs(markY - nowY) - markHalf - nowHalf < 20;
}

function ghostStyle(box: { x: number; y: number; w: number; h: number } | undefined): React.CSSProperties {
  if (!box) return { display: "none" };
  return { left: box.x, top: box.y, width: box.w, height: box.h };
}

function DayPill({ hour, blockX, "data-testid": testId }: { hour: number; blockX: number; "data-testid"?: string }) {
  const y = dayY(hour);
  const width = 52;
  const x = DAY_GUTTER - 6 - width;
  return (
    <>
      <div className="leader" style={{ left: DAY_GUTTER - 6, width: Math.max(0, blockX - DAY_GUTTER + 4), top: y }} />
      <div className="gutter-pill" data-testid={testId} style={{ left: x, top: y - 11, width, height: 22 }}>{gutterClock(hour)}</div>
    </>
  );
}

function NowMark({ hour, left, width, hidePill }: { hour: number; left: number; width: number; hidePill: boolean }) {
  const useDay = left >= DAY_GUTTER - 1 && width > 200;
  const top = useDay ? dayY(hour) : weekY(hour);
  return (
    <>
      <div className="now-line" style={{ left, width, top }}><i /></div>
      {hidePill ? null : (
        <div className="now-pill" style={useDay ? { left: left - 46, top: top - 8, width: 40, height: 16 } : { left: 1, top: top - 8, width: 34, height: 16 }}>{exactClock(hour)}</div>
      )}
    </>
  );
}

function EventButton(props: {
  event: CalEvent;
  box: DayBox;
  tap: TapBox;
  lifted: boolean;
  open: boolean;
  glow: boolean;
  settle: Settle | null;
  lockId: string | null;
  highlight?: "cross-day";
  onPointerDown: (event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: CalEvent, key: React.KeyboardEvent) => void;
  onOpen: (event: CalEvent) => void;
}) {
  const { event, box, tap } = props;
  const one = box.h < 40;
  const time = box.w > 200 ? rangeLabel(event.startHour, event.endHour) : shortRange(event.startHour, event.endHour);
  const motion = settleMotion(props.settle, event.id);
  const locked = props.lockId === event.id ? "settle-lock" : "";
  return (
    <button
      type="button"
      className={props.lifted ? "block lifted" : props.open ? "block open" : "block"}
      style={{ left: tap.x, top: tap.y, width: tap.w, height: tap.h }}
      aria-label={eventLabel(event)}
      data-testid={`block-${event.id}`}
      data-title={event.title}
      data-highlight={props.highlight}
      onPointerDown={(pointer) => props.onPointerDown(event, pointer)}
      onKeyDown={(key) => props.onKeyDown(event, key)}
      onClick={() => props.onOpen(event)}
      onContextMenu={(menu) => menu.preventDefault()}
    >
      <span
        className={`face ${event.state} ${one ? "one" : ""} ${props.glow ? "glow" : ""} ${props.open ? "open" : ""} ${event.domain} ${locked} ${motion.className}`}
        style={{
          left: box.x - tap.x,
          top: box.y - tap.y,
          width: box.w,
          height: box.h,
          backgroundColor: event.state === "proposed" || event.state === "unplaced" ? "color-mix(in srgb, currentColor 12%, transparent)" : event.state === "done" ? "#16181b" : fill(event.domain),
          color: event.state === "proposed" || event.state === "unplaced" ? line(event.domain) : event.state === "done" ? undefined : text(event.domain),
          ...motion.style,
        }}
      >
        {event.state === "approved" || event.state === "done" ? <i className="bar" style={{ background: line(event.domain) }} /> : null}
        <i className="dash" data-on={event.state === "proposed" || event.state === "unplaced" ? "1" : "0"} />
        <span className="body">
          {event.state === "done" ? <span className="done-check"><CheckGlyph /></span> : null}
          <strong>{event.title}</strong>
          {one && !(props.lifted && box.w < 200) ? <span>{event.state === "unplaced" ? `${clockMinutes(event.startHour)} · Not on calendar` : time}</span> : null}
          {!one ? <span>{event.state === "unplaced" ? `${clockMinutes(event.startHour)} · Not on calendar` : `${time}${event.state === "proposed" ? " · Proposed" : ""}`}</span> : null}
        </span>
      </span>
      {event.state === "proposed" ? (
        <span className="corner" style={{ left: box.x - tap.x + box.w - 8, top: box.y - tap.y, color: line(event.domain) }}>
          <i className="halo" style={{ background: event.startHour >= 9 && event.startHour < 17 ? "var(--workband)" : "var(--bg)" }} />
          <Sparkle />
        </span>
      ) : null}
    </button>
  );
}

function WeekCanvas(props: {
  events: CalEvent[];
  layoutEvents: CalEvent[];
  weekKeys: string[];
  timeZone: string;
  width: number;
  nowHour: number | null;
  todayIndex: number;
  drag: Preview | null;
  glow: string[];
  settle: Settle | null;
  lockId: string | null;
  openId: string | null;
  onPointerDown: (event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: CalEvent, key: React.KeyboardEvent) => void;
  onOpen: (event: CalEvent) => void;
}) {
  const colW = weekColumnWidth(props.width);
  const timed = props.layoutEvents.map((event) => ({
    id: event.id,
    day: Math.max(0, props.weekKeys.indexOf(event.dayKey)),
    start: event.startHour,
    end: event.endHour,
  }));
  const boxes = weekBoxes(timed, props.width);
  const markY = props.drag ? weekY(props.drag.startHour) : null;
  const titlePx = 11;
  const measure = (value: string) => {
    const canvas = measureCanvas(titlePx);
    return canvas ? canvas.measureText(value).width : value.length * (titlePx * 0.55);
  };
  return (
    <>
      {[0, 1, 2, 3, 4].map((day) => (
        <div key={day} className="workband" style={{ left: WEEK_GUTTER + day * colW, top: weekY(9), width: colW, height: weekY(17) - weekY(9) }} />
      ))}
      {props.weekKeys.map((key, day) => (
        <div
          key={key}
          className="week-column"
          data-testid={`week-column-${dayName(key).toLowerCase()}`}
          data-scroll-synced="1"
          data-dst-hours={String(PlanTime.dayMinutes(key, props.timeZone) / 60)}
          style={{ position: "absolute", left: WEEK_GUTTER + day * colW, top: 0, width: colW, height: "100%", pointerEvents: "none" }}
        />
      ))}
      {props.drag ? <div className="ghost" style={ghostStyle(boxes.find((box) => box.id === props.drag?.id))} /> : null}
      {props.events.map((event) => {
        const box = boxes.find((item) => item.id === event.id);
        if (!box) return null;
        const lifted = props.drag?.id === event.id;
        const originDay = Math.max(0, props.weekKeys.indexOf(event.dayKey));
        const dx = lifted && props.drag ? (props.drag.dayIndex - originDay) * colW : 0;
        const dy = lifted && props.drag ? weekY(props.drag.startHour) - weekY(event.startHour) : 0;
        const moved = dx === 0 && dy === 0 ? box : { ...box, x: box.x + dx, y: box.y + dy };
        const visibleIds = new Set(props.events.map((item) => item.id));
        const painted = paintedWeekSpan(box, boxes, visibleIds, props.width);
        const lines = wrapWeekTitle(event.title, Math.max(8, box.w - 8), Math.max(1, Math.floor((box.h - 3) / 13)), measure);
        const motion = settleMotion(props.settle, event.id);
        const locked = props.lockId === event.id ? "settle-lock" : "";
        return (
          <button
            key={event.id}
            type="button"
            className={lifted ? "block lifted" : props.openId === event.id ? "block open" : "block"}
            data-narrow={painted.w < 28 ? "1" : "0"}
            style={{ left: painted.x + dx, top: moved.y, width: painted.w, height: moved.h }}
            aria-label={eventLabel(event)}
            data-testid={`block-${event.id}`}
            data-title={event.title}
            onPointerDown={(pointer) => props.onPointerDown(event, pointer)}
            onKeyDown={(key) => props.onKeyDown(event, key)}
            onClick={() => props.onOpen(event)}
            onContextMenu={(menu) => menu.preventDefault()}
          >
            <span
              className={`face ${event.state} ${props.glow.includes(event.id) ? "glow" : ""} ${props.openId === event.id ? "open" : ""} ${locked} ${motion.className}`}
              style={{
                ...WEEK_FACE_REST,
                backgroundColor: event.state === "proposed" || event.state === "unplaced" ? "color-mix(in srgb, currentColor 12%, transparent)" : fill(event.domain),
                color: event.state === "proposed" || event.state === "unplaced" ? line(event.domain) : text(event.domain),
                ...motion.style,
              }}
            >
              {event.state === "approved" ? <i className="bar" style={{ background: line(event.domain) }} /> : null}
              <i className="dash" data-on={event.state === "proposed" || event.state === "unplaced" ? "1" : "0"} />
              <span className="body" style={{ top: 2, right: 1, bottom: 2, left: 4, justifyContent: "flex-start" }}>
                {lines.lines.map((lineText) => (
                  <strong key={lineText} className="week-title">{lineText}</strong>
                ))}
              </span>
            </span>
            {event.state === "proposed" ? (
              <span className="corner" style={{ right: 0, top: 0, color: line(event.domain) }}>
                <i className="halo" style={{ background: event.startHour >= 9 && event.startHour < 17 ? "var(--workband)" : "var(--bg)" }} />
                <Sparkle />
              </span>
            ) : null}
          </button>
        );
      })}
      {props.nowHour != null && props.todayIndex >= 0 ? (
        <NowMark hour={props.nowHour} left={WEEK_GUTTER} width={props.width - WEEK_GUTTER} hidePill={hideNowPill(markY, weekY(props.nowHour), 8, 8)} />
      ) : null}
      {props.drag ? <div className="gutter-pill week" style={{ left: 1, top: weekY(props.drag.startHour) - 8, width: 34, height: 16 }}>{gutterClock(props.drag.startHour)}</div> : null}
    </>
  );
}

let canvasContext: CanvasRenderingContext2D | null | undefined;
function measureCanvas(px: number): CanvasRenderingContext2D | null {
  if (canvasContext === undefined) {
    canvasContext = document.createElement("canvas").getContext("2d");
  }
  if (canvasContext) canvasContext.font = `600 ${px}px Inter, system-ui, sans-serif`;
  return canvasContext;
}

function fill(domain: string): string {
  if (domain === "home") return "var(--home-fill)";
  if (domain === "personal") return "var(--personal-fill)";
  return "var(--work-fill)";
}
function line(domain: string): string {
  if (domain === "home") return "var(--home-line)";
  if (domain === "personal") return "var(--personal-line)";
  return "var(--work-line)";
}
function text(domain: string): string {
  if (domain === "home") return "var(--home-text)";
  if (domain === "personal") return "var(--personal-text)";
  return "var(--work-text)";
}

function ShowSheet({ filters, onChange }: { filters: ShowFilters; onChange: (next: ShowFilters) => void }) {
  const rows: Array<{ key: keyof ShowFilters; label: string; sub?: string; color?: string }> = [
    { key: "work", label: "Work", color: "var(--work-line)" },
    { key: "home", label: "Home", color: "var(--home-line)" },
    { key: "personal", label: "Personal", color: "var(--personal-line)" },
    { key: "proposals", label: "Agent proposals", sub: "Dashed blocks, corner mark" },
  ];
  return (
    <div className="sheet" role="dialog" aria-label="Show">
      <div className="sheet-grip" />
      <h2>Show</h2>
      <p className="sub">Filters hide blocks from view only.</p>
      {rows.map((row) => (
        <button key={row.key} type="button" className="show-row" aria-pressed={filters[row.key]} style={{ minHeight: row.sub ? 60 : 52 }} onClick={() => onChange({ ...filters, [row.key]: !filters[row.key] })}>
          {row.color ? <i className="swatch" style={{ background: row.color }} /> : <Sparkle />}
          <span>{row.label}{row.sub ? <small>{row.sub}</small> : null}</span>
          <span className="toggle" data-on={filters[row.key] ? "true" : "false"} aria-hidden="true"><u /></span>
        </button>
      ))}
    </div>
  );
}

function SearchSheet(props: { events: CalEvent[]; query: string; onQuery: (value: string) => void; onPick: (event: CalEvent) => void }) {
  return (
    <div className="sheet" role="dialog" aria-label="Search">
      <div className="sheet-grip" />
      <h2>Search</h2>
      <input className="search-field" aria-label="Search events" value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Event name" />
      {props.events.slice(0, 8).map((event) => (
        <button key={event.id} type="button" className="row" onClick={() => props.onPick(event)}>
          {event.title}
          <small style={{ marginLeft: "auto", color: "var(--t2)" }}>{dayName(event.dayKey)} {clock(event.startHour)}</small>
        </button>
      ))}
      {props.query && props.events.length === 0 ? <p className="sub">No matching events.</p> : null}
    </div>
  );
}

function SettingsSheet({ meta }: { meta: Meta | null }) {
  return (
    <div className="sheet" role="dialog" aria-label="Settings">
      <div className="sheet-grip" />
      <h2>Settings</h2>
      <p className="sub">A quick drag saves right away. Plan mode waits until you approve.</p>
      <p className="why">{meta?.outlook_gap}</p>
      {meta?.preview ? <p className="why">{meta.preview_banner}</p> : null}
    </div>
  );
}

function SyncSheet({ meta, text }: { meta: Meta | null; text: string }) {
  return (
    <div className="sheet" role="dialog" aria-label="Sync status">
      <div className="sheet-grip" />
      <h2>{text}</h2>
      <p className="sub">{meta?.sync_label}</p>
    </div>
  );
}

function UnscheduledSheet({ tasks }: { tasks: Task[] }) {
  return (
    <div className="sheet" role="dialog" aria-label="Unscheduled">
      <div className="sheet-grip" />
      <h2>Unscheduled</h2>
      <p className="sub">{tasks.length === 0 ? "Everything is on the calendar." : "These tasks are not on the calendar yet."}</p>
      {tasks.map((task) => (
        <div key={task.id} className="row">{task.title}</div>
      ))}
    </div>
  );
}

function EventSheet(props: {
  event: CalEvent | null;
  onClose: () => void;
  onDecide: (event: CalEvent, action: "approve" | "deny") => void;
  onRetry: (event: CalEvent) => void;
  onTime: () => void;
  onDatePick: () => void;
}) {
  const event = props.event;
  if (!event) return null;
  return (
    <div className="sheet" role="dialog" aria-label={event.title} data-testid="details-sheet">
      <div className="sheet-grip" />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2>{event.title}</h2>
        {event.state === "proposed" ? (
          <span className="proposed-chip" style={{ color: line(event.domain) }}><Sparkle /> Proposed</span>
        ) : null}
      </div>
      <p className="sub">{event.state === "unplaced" ? "Not on calendar" : event.state === "proposed" ? `Agent suggestion · ${domainLabel(event.domain)}` : domainLabel(event.domain)}</p>
      <button type="button" className="time-row" data-testid="details-date-row" onClick={props.onDatePick}>
        <span>{dayTitle(event.dayKey)}</span>
        <span>{rangeLabel(event.startHour, event.endHour)} ›</span>
      </button>
      <button type="button" className="time-row quiet" data-testid="details-time-row" onClick={props.onTime}>
        Change time
      </button>
      {event.explanation ? <p className="why">Why: {event.explanation}</p> : null}
      {event.state === "unplaced" ? (
        <button type="button" className="quiet" data-testid="unplaced-retry" onClick={() => props.onRetry(event)}>Retry</button>
      ) : null}
      {event.state === "proposed" ? (
        <div className="pair">
          <button type="button" className="no" onClick={() => props.onDecide(event, "deny")}>Deny</button>
          <button type="button" className="yes" onClick={() => props.onDecide(event, "approve")}>Approve</button>
        </div>
      ) : null}
    </div>
  );
}

function armApproveClickShield() {
  const stop = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".block")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("click", stop, true);
  window.setTimeout(() => document.removeEventListener("click", stop, true), APPROVE_CLICK_SHIELD_MS);
}

function ReviewSheet(props: {
  moves: StagedMove[];
  events: CalEvent[];
  proposals: CalEvent[];
  skipped: string[];
  timeZone: string;
  label: string;
  conflicts: string[];
  disabled: boolean;
  onSkip: (id: string) => void;
  onApprove: () => void;
  onKeep: () => void;
}) {
  const proposals = props.proposals;
  return (
    <div className="sheet" role="dialog" aria-label="Review plan" data-testid="review-sheet">
      <div className="sheet-grip" />
      <h2>Review plan</h2>
      <p className="sub">Your moves and the agent's {proposals.length === 1 ? "suggestion" : "suggestions"} save together. Skip anything you don't want.</p>
      <p className="section-label">YOUR MOVES · {props.moves.length}</p>
      {props.moves.map((move) => {
        const event = props.events.find((item) => item.id === move.id);
        if (!event) return null;
        const from = withMove(event, move.from.start, move.from.end, props.timeZone);
        const to = withMove(event, move.to.start, move.to.end, props.timeZone);
        const crosses = crossesWorkHours(event.domain, PlanTime.weekdayIndex(from.dayKey), from.startHour, from.endHour, PlanTime.weekdayIndex(to.dayKey), to.startHour, to.endHour);
        return (
          <div key={move.id} className="row" data-testid={`plan-item-${move.id}`} data-title={event.title}>
            <i className="swatch" style={{ background: line(event.domain) }} />
            <span>
              <strong>{event.title}</strong>
              <small style={{ display: "block", color: "var(--t2)" }}>{dayName(from.dayKey)} {clock(from.startHour)} → {dayName(to.dayKey)} {clock(to.startHour)}</small>
            </span>
            {crosses ? <span className="tag">Crosses work hours</span> : null}
            {props.conflicts.includes(move.id) ? <span className="tag" data-testid="changed-tag">Changed</span> : null}
          </div>
        );
      })}
      {proposals.length > 0 ? <p className="section-label">AGENT PROPOSAL{proposals.length === 1 ? "" : "S"} · {proposals.length}</p> : null}
      {proposals.map((event) => {
        const skipped = props.skipped.includes(event.id);
        return (
          <div key={event.id} className={skipped ? "row skipped" : "row"} data-testid={`plan-item-${event.id}`} data-title={event.title}>
            <i className="swatch" style={{ background: "transparent", border: `1px dashed ${line(event.domain)}` }} />
            <span style={{ color: line(event.domain) }}>
              <strong>{event.title}</strong>
              <small style={{ display: "block", color: "var(--t2)" }}>Proposed · {dayName(event.dayKey)} {rangeLabel(event.startHour, event.endHour)}</small>
            </span>
            <button type="button" className="skip" aria-label={skipped ? `Include ${event.title}` : `Skip ${event.title}`} onClick={() => props.onSkip(event.id)}>
              {skipped ? "Include" : "Skip"}
            </button>
          </div>
        );
      })}
      <button type="button" className="primary" data-testid="approve-all" disabled={props.disabled} onPointerDown={armApproveClickShield} onClick={props.onApprove}>{props.label}</button>
      <button type="button" className="quiet" onClick={props.onKeep}>Keep planning</button>
    </div>
  );
}

function RevertSheet(props: { count: number; proposals: number; onRevert: () => void; onKeep: () => void }) {
  const noun = props.count === 1 ? "move" : "moves";
  return (
    <div className="sheet" role="dialog" aria-label={`Revert ${props.count} ${noun}?`}>
      <div className="sheet-grip" />
      <h2>Revert {props.count} {noun}?</h2>
      <p className="sub">Every block you moved goes back to where it was. {props.proposals === 1 ? "The agent's proposal stays pending." : "Agent proposals stay pending."}</p>
      <button type="button" className="danger" onClick={props.onRevert}>Revert all</button>
      <button type="button" className="quiet" onClick={props.onKeep}>Keep planning</button>
    </div>
  );
}

function FixedSheet(props: { onCancel: () => void; onMove: () => void }) {
  return (
    <div className="sheet" role="dialog" aria-label="Change this fixed block?">
      <div className="sheet-grip" />
      <h2>Change this fixed block?</h2>
      <p className="sub">This appointment is fixed.</p>
      <div className="pair">
        <button type="button" className="no" onClick={props.onCancel}>Cancel</button>
        <button type="button" className="yes" onClick={props.onMove}>Move it</button>
      </div>
    </div>
  );
}
