import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, reportFailure } from "../api";
import { PlanActions } from "../plan/actions";
import { PlanMachine } from "../plan/planMachine";
import { PlanBoard } from "../plan/selectors";
import { PlanTime } from "../plan/time";
import { TAFO_REV } from "../rev";
import type { CalendarBlock, Meta, Proposal, Task } from "../types";
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
  nearMark,
  weekBoxes,
  weekColumnWidth,
  weekY,
  type DayBox,
  type TapBox,
} from "./geometry";
import {
  PLAN_HINT,
  REVERT_TOAST,
  SYNC_DEMO,
  TIP_TEXT,
  approveLabel,
  approvedToast,
  bannerText,
  clock,
  dayName,
  dayTitle,
  denyToast,
  domainLabel,
  exactClock,
  gutterClock,
  nubLabel,
  quickToast,
  rangeLabel,
  shortRange,
  weekTitle,
} from "./format";
import { COMMIT_PX, gestureDown, gestureMove, gestureUp, HOLD_MS, holdReady, type Gesture } from "./gesture";
import { CheckGlyph, Chevron, MoreGlyph, PlanGlyph, SearchGlyph, Sparkle } from "./icons";
import { ALL_SHOWN, buildEvents, showSummary, visibleEvents, withMove, type CalEvent, type ShowFilters } from "./model";
import { approveDisabled, enterPlan, exitPlan, includedIds, initialPlan, proposalsOnDays, stageMove, toggleSkip, type PlanSession, type StagedMove } from "./session";
import { wrapWeekTitle } from "./titles";
import { showUndo, type UndoToast } from "./undo";
import "./v3.css";

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
  | { kind: "fixed"; id: string; start: string; end: string };

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
  live: boolean;
}

interface Props {
  meta: Meta | null;
  tasks: Task[];
  blocks: CalendarBlock[];
  proposals: Proposal[];
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
  const state = event.state === "proposed" ? ", Proposed" : event.state === "done" ? ", Done" : "";
  return `${event.title}, ${when}${state}`;
}

export function CalendarShell(props: Props) {
  const timeZone = props.meta?.display_timezone || "America/Indianapolis";
  const [mode, setMode] = useState<"day" | "week">("day");
  const [anchor, setAnchor] = useState(() => PlanTime.dayKey(new Date(), timeZone));
  const [plan, setPlan] = useState<PlanSession>(initialPlan);
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
  const [tip, setTip] = useState(false);
  const [glow, setGlow] = useState<string[]>([]);
  const [live, setLive] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [overrides, setOverrides] = useState<Record<string, { start: string; end: string }>>({});
  const [width, setWidth] = useState(390);
  const [frame, setFrame] = useState(false);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<DragOrigin | null>(null);
  const gestureRef = useRef<Gesture>({ phase: "idle" });
  const settleFrom = useRef<{ id: string; left: number; top: number; width: number; height: number } | null>(null);
  const snapRef = useRef<number | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);
  const [lockId, setLockId] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const toastToken = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const serverEvents = useMemo(
    () => buildEvents(props.tasks, props.blocks, props.proposals, timeZone),
    [props.tasks, props.blocks, props.proposals, timeZone],
  );
  const monday = PlanTime.mondayKey(anchor);
  const weekKeys = PlanTime.visibleDayKeys(monday, "week");
  const todayKey = PlanTime.dayKey(now, timeZone);
  const nowParts = PlanTime.parts(now, timeZone);
  const nowHour = nowParts.hour + nowParts.minute / 60;

  const baseEvents = useMemo(() => {
    return serverEvents.map((event) => {
      const move = plan.active ? plan.moves.find((item) => item.id === event.id) : undefined;
      if (move) return withMove(event, move.to.start, move.to.end, timeZone);
      const override = overrides[event.id];
      if (override) return withMove(event, override.start, override.end, timeZone);
      return event;
    });
  }, [serverEvents, plan, overrides, timeZone]);

  const shown = visibleEvents(baseEvents, filters, overlay?.kind === "search" ? "" : query);
  const dragPreview = previewFrom(gesture, originRef.current, mode, monday, gridRef.current, width, gesture.phase === "lifted" ? snapRef.current : null);
  if (gesture.phase === "lifted" && dragPreview) snapRef.current = dragPreview.startHour;
  if (gesture.phase === "idle") snapRef.current = null;
  const events = shown.map((event) => {
    if (!dragPreview || dragPreview.id !== event.id) return event;
    const start = atHour(dragPreview.dayKey, dragPreview.startHour, timeZone);
    const end = atHour(dragPreview.dayKey, dragPreview.startHour + (originRef.current?.duration ?? 0.5), timeZone);
    return start && end ? withMove(event, start, end, timeZone) : event;
  });

  const dayEvents = shown.filter((event) => event.dayKey === anchor);
  const weekEvents = shown.filter((event) => weekKeys.includes(event.dayKey));
  const rangeIds = proposalsOnDays(events, mode === "day" ? [anchor] : weekKeys).map((event) => event.id);
  const included = includedIds(rangeIds, plan.skipped);
  const unsavedFits = bannerText(plan.moves.length, rangeIds.length, true).length < 42;
  const banner = bannerText(plan.moves.length, rangeIds.length, unsavedFits && plan.moves.length > 0 && rangeIds.length === 0);
  const loose = PlanBoard.sidebarTasks(props.tasks, props.blocks, props.proposals, "unscheduled", "");

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

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
        setSettle((current) => (current && !current.live ? { ...current, live: true } : current));
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

  function pushToast(message: string, undoFn?: () => Promise<void>) {
    const token = toastToken.current + 1;
    toastToken.current = token;
    setToast(showUndo(message, null, Date.now(), token));
    setUndo(() => undoFn ?? null);
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

  async function writeBlock(block: CalendarBlock, title: string, start: string, end: string, acknowledgeFixed = false) {
    const proposal = await PlanActions.updateBlock({
      block,
      title,
      startsAt: start,
      endsAt: end,
      timeZone,
      key: PlanActions.gestureKey("move"),
      explanation: `Moved ${title}.`,
    });
    return PlanActions.approve(proposal, acknowledgeFixed);
  }

  async function saveQuick(event: CalEvent, startIso: string, endIso: string, acknowledgeFixed = false) {
    if (busy) return;
    const original = { start: event.start, end: event.end };
    setOverrides((current) => ({ ...current, [event.id]: { start: startIso, end: endIso } }));
    setBusy(true);
    try {
      if (event.kind === "proposal") {
        const proposal = propsRef.current.proposals.find((item) => item.id === event.id);
        if (!proposal) return;
        const payload = { ...PlanBoard.payload(proposal), starts_at: startIso, ends_at: endIso };
        await api(`/api/decisions/${proposal.id}/edit`, {
          method: "POST",
          body: JSON.stringify({ expected_version: proposal.version, confirmed: true, payload }),
        });
        const hour = withMove(event, startIso, endIso, timeZone).startHour;
        pushToast(quickToast(event.title, hour), async () => {
          await api(`/api/decisions/${proposal.id}/edit`, {
            method: "POST",
            body: JSON.stringify({
              expected_version: proposal.version + 1,
              confirmed: true,
              payload: { ...payload, starts_at: original.start, ends_at: original.end },
            }),
          });
          await propsRef.current.onRefresh();
        });
      } else {
        const block = propsRef.current.blocks.find((item) => item.id === event.id);
        if (!block) return;
        const saved = await writeBlock(block, event.title, startIso, endIso, acknowledgeFixed);
        const hour = withMove(event, startIso, endIso, timeZone).startHour;
        const message = quickToast(event.title, hour);
        const nextBlock = saved.block;
        pushToast(message, nextBlock ? async () => {
          await writeBlock(nextBlock, event.title, original.start, original.end, acknowledgeFixed);
          setOverrides((current) => {
            const copy = { ...current };
            delete copy[event.id];
            return copy;
          });
          await propsRef.current.onRefresh();
        } : undefined);
        rememberTip(message);
      }
      glowIds([event.id]);
      await propsRef.current.onRefresh();
      setOverrides((current) => {
        const copy = { ...current };
        delete copy[event.id];
        return copy;
      });
    } catch (error) {
      await fail(error);
    } finally {
      setBusy(false);
    }
  }

  function stagePreview(eventId: string, preview: Preview) {
    const server = serverEvents.find((item) => item.id === eventId);
    if (!server) return;
    const existing = plan.moves.find((item) => item.id === eventId);
    const duration = server.endHour - server.startHour;
    const start = atHour(preview.dayKey, preview.startHour, timeZone);
    const end = atHour(preview.dayKey, preview.startHour + duration, timeZone);
    if (!start || !end) return;
    const move: StagedMove = {
      id: eventId,
      kind: server.kind,
      from: existing?.from ?? { start: server.start, end: server.end },
      to: { start, end },
      fromDayKey: existing?.fromDayKey ?? server.dayKey,
      dayKey: preview.dayKey,
    };
    setPlan((current) => stageMove(current, move));
  }

  function openEvent(event: CalEvent) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setOverlay({ kind: "event", id: event.id });
  }

  function finishGesture(released: Gesture) {
    if (released.phase === "idle") return;
    const event = baseEvents.find((item) => item.id === released.eventId) ?? serverEvents.find((item) => item.id === released.eventId);
    if (!event) return;
    const preview = previewFrom(released, originRef.current, mode, monday, gridRef.current, width, snapRef.current);
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
      const current = gestureRef.current;
      const point = current.phase === "idle"
        ? { x: native.clientX, y: native.clientY }
        : current.point;
      const released = gestureMove(current, point, performance.now());
      const result = gestureUp(released);
      if (native.type !== "pointercancel" && result.tap) {
        const dayKey = event.dayKey;
        const eventId = event.id;
        const weekTap = mode === "week";
        let sawClick = false;
        const note = () => { sawClick = true; };
        window.addEventListener("click", note, true);
        window.setTimeout(() => {
          window.removeEventListener("click", note, true);
          if (sawClick) return;
          if (weekTap) {
            setAnchor(dayKey);
            setMode("day");
          } else {
            setOverlay({ kind: "event", id: eventId });
          }
        }, 80);
      }
      if (result.commit && released.phase === "lifted") {
        suppressClick.current = true;
        const face = gridRef.current?.querySelector(`[data-testid="block-${released.eventId}"] .face`);
        if (face instanceof HTMLElement) {
          const rect = face.getBoundingClientRect();
          settleFrom.current = { id: released.eventId, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
        setLockId(released.eventId);
        finishGesture(released);
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
    const hit = blockUnder(pointer.clientX, pointer.clientY);
    if (hit) {
      startGesture(hit, pointer);
      return;
    }
    const target = pointer.target;
    if (target instanceof Element && target.closest(".block, .slim")) return;
    if (pointer.pointerType === "touch") trackPan(pointer.pointerId, pointer.clientY);
  }

  function onPointerDown(event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) {
    if (pointer.button !== 0) return;
    startGesture(event, pointer);
  }

  function nudge(event: CalEvent, minutes: number, days: number) {
    const span = PlanMachine.nudge(event.start, event.end, minutes, days, timeZone);
    if (!span) return;
    if (plan.active) {
      const server = serverEvents.find((item) => item.id === event.id);
      if (!server) return;
      const existing = plan.moves.find((item) => item.id === event.id);
      setPlan((current) => stageMove(current, {
        id: event.id,
        kind: server.kind,
        from: existing?.from ?? { start: server.start, end: server.end },
        to: { start: span.starts_at, end: span.ends_at },
        fromDayKey: existing?.fromDayKey ?? server.dayKey,
        dayKey: PlanTime.dayKey(new Date(span.starts_at), timeZone),
      }));
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
    if (busy || approveDisabled(plan.moves.length, included.length)) return;
    const moves = [];
    const approvals = [];
    for (const move of plan.moves) {
      const event = serverEvents.find((item) => item.id === move.id);
      if (!event) continue;
      if (event.kind === "proposal") {
        approvals.push({
          proposal_id: event.id,
          expected_version: event.version,
          starts_at: move.to.start,
          ends_at: move.to.end,
        });
      } else {
        moves.push({
          block_id: event.id,
          expected_version: event.version,
          starts_at: move.to.start,
          ends_at: move.to.end,
          idempotency_key: PlanActions.gestureKey("plan"),
          title: event.title,
          acknowledge_fixed_move: event.fixed,
        });
      }
    }
    for (const id of included) {
      if (approvals.some((item) => item.proposal_id === id)) continue;
      const event = serverEvents.find((item) => item.id === id);
      if (!event) continue;
      approvals.push({ proposal_id: id, expected_version: event.version });
    }
    setBusy(true);
    try {
      await api("/api/decisions/plan/commit", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, moves, approvals }),
      });
      const message = approvedToast(moves.length, approvals.length);
      setPlan(exitPlan());
      setOverlay(null);
      glowIds([...moves.map((item) => item.block_id), ...approvals.map((item) => item.proposal_id)]);
      pushToast(message);
      await propsRef.current.onRefresh();
    } catch (error) {
      await fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function decide(event: CalEvent, action: "approve" | "deny") {
    const proposal = props.proposals.find((item) => item.id === event.id);
    if (!proposal || busy) return;
    setBusy(true);
    try {
      if (action === "deny") {
        await PlanActions.reject(proposal, "Denied");
        pushToast(denyToast(event.title));
      } else {
        await PlanActions.approve(proposal);
        pushToast(`Approved ${event.title}.`);
        glowIds([event.id]);
      }
      setOverlay(null);
      await propsRef.current.onRefresh();
    } catch (error) {
      await fail(error);
    } finally {
      setBusy(false);
    }
  }

  function openPlan() {
    setPlan(enterPlan());
    setOverlay(null);
    setTip(false);
  }

  function revertAll() {
    const ids = plan.moves.map((move) => move.id);
    setPlan(exitPlan());
    setOverlay(null);
    glowIds(ids);
    pushToast(REVERT_TOAST);
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
          text={banner}
          live={lifted && liveParts != null}
          liveTitle={liveParts?.title ?? ""}
          liveWhen={liveParts?.when ?? ""}
          crossing={lifted && crossing}
          onExit={() => { setPlan(exitPlan()); setOverlay(null); }}
          onRevert={() => setOverlay({ kind: "revert" })}
          onReview={() => setOverlay({ kind: "review" })}
        />
      ) : (
        <header className="v3-header">
          <h1>{mode === "day" ? dayTitle(anchor) : weekTitle(monday)}</h1>
          <button type="button" className="icon-btn" data-testid="plan-button" aria-label="Plan mode" title={PLAN_HINT} onClick={openPlan}>
            <PlanGlyph />
          </button>
          <button type="button" className="view-switch" data-testid="view-switch" aria-haspopup="menu" aria-expanded={overlay?.kind === "view"} onClick={() => setOverlay(overlay?.kind === "view" ? null : { kind: "view" })}>
            {mode === "day" ? "Day" : "Week"} <Chevron />
          </button>
          <button type="button" className="icon-btn" data-testid="more-button" aria-label="More" aria-haspopup="menu" aria-expanded={overlay?.kind === "menu"} onClick={() => setOverlay(overlay?.kind === "menu" ? null : { kind: "menu" })}>
            <MoreGlyph />
          </button>
        </header>
      )}
      {mode === "day" ? (
        <div className="v3-dow" role="radiogroup" aria-label="Days" data-testid="day-strip">
          {weekKeys.map((key) => {
            const proposed = serverEvents.some((event) => event.dayKey === key && event.state === "proposed");
            return (
              <button
                key={key}
                type="button"
                className="day-pill"
                role="radio"
                aria-checked={key === anchor}
                onClick={() => setAnchor(key)}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key !== "ArrowRight" && keyEvent.key !== "ArrowLeft") return;
                  keyEvent.preventDefault();
                  const step = keyEvent.key === "ArrowRight" ? 1 : -1;
                  setAnchor(PlanTime.addDaysToKey(key, step));
                }}
              >
                <small>{dayName(key)}</small>
                <b>{Number(key.slice(-2))}</b>
                {proposed ? <Sparkle /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="v3-dow" data-testid="week-strip">
          {weekKeys.map((key) => (
            <button key={key} type="button" className="week-head" data-today={key === todayKey} onClick={() => { setAnchor(key); setMode("day"); }}>
              <small>{dayName(key).slice(0, 1)}</small>
              <b>{Number(key.slice(-2))}</b>
            </button>
          ))}
        </div>
      )}
      <div
        className="v3-grid"
        ref={gridRef}
        data-testid={mode === "day" ? "day-grid" : "week-grid"}
        data-hour-px={mode === "day" ? DAY_PX : WEEK_PX}
        data-origin={mode === "day" ? DAY_ORIGIN : WEEK_ORIGIN}
        data-gutter={mode === "day" ? DAY_GUTTER : WEEK_GUTTER}
        aria-busy={props.loading}
        onPointerDownCapture={onGridPointerDown}
      >
        <div className="grid-canvas" style={{ height: mode === "day" ? dayY(20) : weekY(20) }}>
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
          {mode === "day" ? (
            <DayCanvas
              events={dayEvents}
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
            />
          ) : (
            <WeekCanvas
              events={weekEvents}
              weekKeys={weekKeys}
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
              onOpenDay={(key) => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setAnchor(key);
                setMode("day");
              }}
            />
          )}
        </div>
      </div>
      <div className="v3-tray">
        <span className="tray-grip" aria-hidden="true" />
        <button type="button" className="unscheduled" data-testid="unscheduled" onClick={() => setOverlay({ kind: "unscheduled" })}>
          Unscheduled <b>{loose.length}</b>
        </button>
        <button type="button" className="sync-chip" data-testid="sync-chip" onClick={() => setOverlay({ kind: "sync" })}>
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
            <span className={toast.message.startsWith("Reverted") || toast.message.startsWith("Denied") ? "toast-icon plain" : "toast-icon"} aria-hidden="true">
              <CheckGlyph />
            </span>
            <p>{toast.message}</p>
            {undo ? <button type="button" onClick={() => { const run = undo; setToast(null); setUndo(null); void run(); }}>Undo</button> : null}
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
          onTime={() => pushToast("Drag the block to change the time.")}
        />
      ) : null}
      {overlay.kind === "review" ? (
        <ReviewSheet
          moves={plan.moves}
          events={serverEvents}
          proposals={serverEvents.filter((event) => event.state === "proposed" && (mode === "day" ? event.dayKey === anchor : weekKeys.includes(event.dayKey)))}
          skipped={plan.skipped}
          timeZone={timeZone}
          onSkip={(id) => setPlan((current) => toggleSkip(current, id))}
          onApprove={() => void approveAll()}
          onKeep={() => setOverlay(null)}
          disabled={approveDisabled(plan.moves.length, included.length) || busy}
          label={approveLabel(plan.moves.length, included.length)}
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
): Preview | null {
  if (gesture.phase !== "lifted" || !origin || !grid) return null;
  const rect = grid.getBoundingClientRect();
  const moved = moveByPointer({
    originStart: origin.startHour,
    originDay: Math.max(0, origin.dayIndex),
    duration: origin.duration,
    deltaY: gesture.point.y - gesture.origin.y,
    pointerX: gesture.point.x - rect.left,
    pxPerHour: mode === "day" ? DAY_PX : WEEK_PX,
    gutter: mode === "day" ? DAY_GUTTER : WEEK_GUTTER,
    columnWidth: mode === "day" ? width : weekColumnWidth(width),
    allowDayChange: mode === "week",
    previousSnap,
  });
  if (Math.hypot(gesture.point.x - gesture.origin.x, gesture.point.y - gesture.origin.y) < COMMIT_PX) return null;
  return {
    id: origin.id,
    dayIndex: moved.day,
    dayKey: mode === "week" ? PlanTime.addDaysToKey(monday, moved.day) : origin.dayKey,
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

function PlanBanner(props: {
  count: number;
  text: string;
  live: boolean;
  liveTitle: string;
  liveWhen: string;
  crossing: boolean;
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
        ) : <p>{props.text}</p>}
      </div>
      {props.live && props.crossing ? <span className="tag">Crosses work hours</span> : null}
      {!props.live && props.count === 0 ? <button type="button" className="ghost-btn" onClick={props.onExit}>Exit</button> : null}
      {!props.live && props.count > 0 ? (
        <div className="banner-actions">
          <button type="button" className="ghost-btn" onClick={props.onRevert}>Revert</button>
          <button type="button" className="solid-btn" onClick={props.onReview}>Review</button>
        </div>
      ) : null}
    </div>
  );
}

function settleMotion(settle: Settle | null, id: string): { className: string; style: React.CSSProperties } {
  if (!settle || settle.id !== id || settle.live) {
    return { className: settle?.id === id && settle.live ? "settling live" : "", style: {} };
  }
  return {
    className: "settling",
    style: {
      position: "absolute",
      left: settle.park.left,
      top: settle.park.top,
      width: settle.park.width,
      height: settle.park.height,
      right: "auto",
      bottom: "auto",
    },
  };
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
  onPointerDown: (event: CalEvent, pointer: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: CalEvent, key: React.KeyboardEvent) => void;
  onOpen: (event: CalEvent) => void;
}) {
  const timed = props.events.map((event) => ({ id: event.id, start: event.startHour, end: event.endHour }));
  const boxes = dayBoxes(timed, props.width);
  const taps = dayTaps(timed, props.width);
  const markY = props.drag ? dayY(props.drag.startHour) : null;
  const hours = [];
  for (let hour = 9; hour <= 18; hour += 1) hours.push(hour);
  return (
    <>
      <div className="workband" style={{ left: DAY_GUTTER, top: dayY(9), right: 0, height: dayY(17) - dayY(9) }} />
      <div className="work-end" style={{ top: dayY(17) - 4 }}>Work hours end</div>
      {hours.map((hour) => (
        <div key={hour}>
          <div className="hour-line" style={{ top: dayY(hour) }} />
          {nearMark(markY, dayY(hour), 15) ? null : (
            <div className="hour-label" style={{ top: dayY(hour), right: props.width - DAY_GUTTER + 8 }}>{clock(hour)}</div>
          )}
        </div>
      ))}
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
            onPointerDown={props.onPointerDown}
            onKeyDown={props.onKeyDown}
            onOpen={props.onOpen}
          />
        );
      })}
      {props.nowHour != null ? <NowMark hour={props.nowHour} left={DAY_GUTTER} width={props.width - DAY_GUTTER} hidePill={hideNowPill(markY, dayY(props.nowHour), 11, 8)} /> : null}
      {props.drag ? <DayPill hour={props.drag.startHour} blockX={boxes.find((box) => box.id === props.drag?.id)?.x ?? DAY_GUTTER} /> : null}
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

function DayPill({ hour, blockX }: { hour: number; blockX: number }) {
  const y = dayY(hour);
  const width = 52;
  const x = DAY_GUTTER - 6 - width;
  return (
    <>
      <div className="leader" style={{ left: DAY_GUTTER - 6, width: Math.max(0, blockX - DAY_GUTTER + 4), top: y }} />
      <div className="gutter-pill" style={{ left: x, top: y - 11, width, height: 22 }}>{gutterClock(hour)}</div>
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
          background: event.state === "approved" ? fill(event.domain) : undefined,
          color: event.state === "proposed" ? line(event.domain) : event.state === "done" ? undefined : text(event.domain),
          ...motion.style,
        }}
      >
        {event.state === "approved" ? <i className="bar" style={{ background: line(event.domain) }} /> : null}
        {event.state === "proposed" ? <i className="dash" /> : null}
        <span className="body">
          {event.state === "done" ? <span className="done-check"><CheckGlyph /></span> : null}
          <strong>{event.title}</strong>
          {one && !(props.lifted && box.w < 200) ? <span>{time}</span> : null}
          {!one ? <span>{time}{event.state === "proposed" ? " · Proposed" : ""}</span> : null}
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
  weekKeys: string[];
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
  onOpenDay: (dayKey: string) => void;
}) {
  const colW = weekColumnWidth(props.width);
  const timed = props.events.map((event) => ({
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
      {Array.from({ length: 13 }, (_, index) => WEEK_ORIGIN + index).map((hour) => (
        <div key={hour}>
          <div className="hour-line" style={{ top: weekY(hour) }} />
          {hour < 20 && !nearMark(markY, weekY(hour), 12) ? (
            <div className="hour-label" style={{ top: weekY(hour), left: 0, width: WEEK_GUTTER, textAlign: "right", paddingRight: 4 }}>{clock(hour)}</div>
          ) : null}
        </div>
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
        if (box.slim) {
          return (
            <button
              key={event.id}
              type="button"
              className="slim"
              style={{ left: moved.x, top: moved.y, width: moved.w, height: moved.h, background: fill(event.domain), color: line(event.domain) }}
              aria-label={nubLabel(event.title, event.startHour, event.endHour)}
              aria-description="Opens the day"
              onClick={() => props.onOpenDay(event.dayKey)}
            />
          );
        }
        const lines = wrapWeekTitle(event.title, Math.max(8, box.w - 8), Math.max(1, Math.floor((box.h - 3) / 13)), measure);
        const motion = settleMotion(props.settle, event.id);
        const locked = props.lockId === event.id ? "settle-lock" : "";
        return (
          <button
            key={event.id}
            type="button"
            className={lifted ? "block lifted" : props.openId === event.id ? "block open" : "block"}
            style={{ left: moved.x, top: moved.y, width: moved.w, height: moved.h }}
            aria-label={eventLabel(event)}
            data-testid={`block-${event.id}`}
            onPointerDown={(pointer) => props.onPointerDown(event, pointer)}
            onKeyDown={(key) => props.onKeyDown(event, key)}
            onClick={() => props.onOpenDay(event.dayKey)}
            onContextMenu={(menu) => menu.preventDefault()}
          >
            <span
              className={`face ${event.state} ${props.glow.includes(event.id) ? "glow" : ""} ${props.openId === event.id ? "open" : ""} ${locked} ${motion.className}`}
              style={{
                inset: 0,
                background: event.state === "approved" ? fill(event.domain) : undefined,
                color: event.state === "proposed" ? line(event.domain) : text(event.domain),
                ...motion.style,
              }}
            >
              {event.state === "approved" ? <i className="bar" style={{ background: line(event.domain) }} /> : null}
              {event.state === "proposed" ? <i className="dash" /> : null}
              <span className="body" style={{ inset: "2px 1px 2px 4px", justifyContent: "flex-start" }}>
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
  onTime: () => void;
}) {
  const event = props.event;
  if (!event) return null;
  return (
    <div className="sheet" role="dialog" aria-label={event.title}>
      <div className="sheet-grip" />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2>{event.title}</h2>
        {event.state === "proposed" ? (
          <span className="proposed-chip" style={{ color: line(event.domain) }}><Sparkle /> Proposed</span>
        ) : null}
      </div>
      <p className="sub">{event.state === "proposed" ? `Agent suggestion · ${domainLabel(event.domain)}` : domainLabel(event.domain)}</p>
      <button type="button" className="time-row" onClick={props.onTime}>
        <span>{dayTitle(event.dayKey)}</span>
        <span>{rangeLabel(event.startHour, event.endHour)} ›</span>
      </button>
      {event.explanation ? <p className="why">Why: {event.explanation}</p> : null}
      {event.state === "proposed" ? (
        <div className="pair">
          <button type="button" className="no" onClick={() => props.onDecide(event, "deny")}>Deny</button>
          <button type="button" className="yes" onClick={() => props.onDecide(event, "approve")}>Approve</button>
        </div>
      ) : null}
    </div>
  );
}

function ReviewSheet(props: {
  moves: StagedMove[];
  events: CalEvent[];
  proposals: CalEvent[];
  skipped: string[];
  timeZone: string;
  label: string;
  disabled: boolean;
  onSkip: (id: string) => void;
  onApprove: () => void;
  onKeep: () => void;
}) {
  const proposals = props.proposals;
  return (
    <div className="sheet" role="dialog" aria-label="Review plan">
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
          <div key={move.id} className="row">
            <i className="swatch" style={{ background: line(event.domain) }} />
            <span>
              <strong>{event.title}</strong>
              <small style={{ display: "block", color: "var(--t2)" }}>{dayName(from.dayKey)} {clock(from.startHour)} → {dayName(to.dayKey)} {clock(to.startHour)}</small>
            </span>
            {crosses ? <span className="tag">Crosses work hours</span> : null}
          </div>
        );
      })}
      {proposals.length > 0 ? <p className="section-label">AGENT PROPOSAL{proposals.length === 1 ? "" : "S"} · {proposals.length}</p> : null}
      {proposals.map((event) => {
        const skipped = props.skipped.includes(event.id);
        return (
          <div key={event.id} className={skipped ? "row skipped" : "row"}>
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
      <button type="button" className="primary" disabled={props.disabled} onClick={props.onApprove}>{props.label}</button>
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
