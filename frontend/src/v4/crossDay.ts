/** Cross-day peek-and-return drag (AC 31–35). Pure state; Shell wires pointer + view. */

export const CROSS_DAY_DWELL_MS = 450;
export const STRIP_HINT_OPACITY = 0.22;
export const ORIGIN_HINT_OPACITY = 0.55;

export type CrossDaySurface = "grid" | "strip" | "tray" | "message";

export type CrossDayOutcome =
  | "idle"
  | "carrying"
  | "peeked"
  | "cancel"
  | "same-day-move"
  | "cross-day-save"
  | "interrupted";

export interface CrossDayPlanStage {
  eventId: string;
  fromDayKey: string;
  toDayKey: string;
  startMinutes: number;
}

export interface CrossDayState {
  phase: "idle" | "carrying";
  originDayKey: string;
  eventId: string;
  scrollMinutes: number;
  viewDayKey: string;
  onStrip: boolean;
  hoverDayKey: string | null;
  dwellMs: number;
  peeked: boolean;
}

export interface CrossDayEffect {
  outcome: CrossDayOutcome;
  stage?: CrossDayPlanStage;
}

export function crossDayIdle(): CrossDayState {
  return {
    phase: "idle",
    originDayKey: "",
    eventId: "",
    scrollMinutes: 0,
    viewDayKey: "",
    onStrip: false,
    hoverDayKey: null,
    dwellMs: 0,
    peeked: false,
  };
}

export function crossDayLift(
  eventId: string,
  originDayKey: string,
  scrollMinutes: number,
): CrossDayState {
  return {
    phase: "carrying",
    originDayKey,
    eventId,
    scrollMinutes,
    viewDayKey: originDayKey,
    onStrip: false,
    hoverDayKey: null,
    dwellMs: 0,
    peeked: false,
  };
}

export function crossDayStripEnter(state: CrossDayState): CrossDayState {
  if (state.phase !== "carrying") return state;
  return { ...state, onStrip: true };
}

export function crossDayStripLeave(state: CrossDayState): CrossDayState {
  if (state.phase !== "carrying") return state;
  return { ...state, onStrip: false, hoverDayKey: null, dwellMs: 0 };
}

export function crossDayHoverCell(state: CrossDayState, dayKey: string): CrossDayState {
  if (state.phase !== "carrying" || !state.onStrip) return state;
  if (dayKey === state.hoverDayKey) return state;
  return { ...state, hoverDayKey: dayKey, dwellMs: 0 };
}

export function crossDayTick(state: CrossDayState, elapsedMs: number): CrossDayState {
  if (state.phase !== "carrying" || !state.hoverDayKey) return state;
  const active = state.onStrip ? state : crossDayStripEnter(state);
  const target = active.hoverDayKey;
  if (!target) return active;
  if (target === active.originDayKey && active.viewDayKey === active.originDayKey) {
    return { ...active, dwellMs: 0 };
  }
  const dwellMs = Math.min(CROSS_DAY_DWELL_MS, active.dwellMs + elapsedMs);
  const peeked = dwellMs >= CROSS_DAY_DWELL_MS;
  return {
    ...active,
    dwellMs,
    peeked: active.peeked || peeked,
    viewDayKey: peeked ? target : active.viewDayKey,
  };
}

export function crossDayRelease(
  state: CrossDayState,
  surface: CrossDaySurface,
  targetMinutes?: number,
  planMode = false,
): { state: CrossDayState; effect: CrossDayEffect } {
  if (state.phase !== "carrying") {
    return { state, effect: { outcome: "idle" } };
  }
  if (surface === "tray" || surface === "message") {
    return { state: crossDayIdle(), effect: { outcome: "cancel" } };
  }
  if (surface === "strip") {
    return { state: crossDayIdle(), effect: { outcome: "cancel" } };
  }
  if (!state.peeked || state.viewDayKey === state.originDayKey) {
    return { state: crossDayIdle(), effect: { outcome: "same-day-move" } };
  }
  const stage: CrossDayPlanStage = {
    eventId: state.eventId,
    fromDayKey: state.originDayKey,
    toDayKey: state.viewDayKey,
    startMinutes: targetMinutes ?? 0,
  };
  return {
    state: crossDayIdle(),
    effect: { outcome: "cross-day-save", stage: planMode ? stage : undefined },
  };
}

export function crossDayInterrupt(state: CrossDayState): { state: CrossDayState; effect: CrossDayEffect } {
  if (state.phase !== "carrying") {
    return { state, effect: { outcome: "idle" } };
  }
  return { state: crossDayIdle(), effect: { outcome: "interrupted" } };
}

export function dwellProgress(state: CrossDayState): number {
  if (!state.hoverDayKey || state.dwellMs <= 0) return 0;
  return Math.min(1, state.dwellMs / CROSS_DAY_DWELL_MS);
}

export function crossDaySurfaceAt(clientX: number, clientY: number): CrossDaySurface {
  const grid = document.querySelector('[data-testid="day-grid"]');
  if (grid instanceof HTMLElement) {
    const box = grid.getBoundingClientRect();
    if (clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return "grid";
  }
  const msg = document.querySelector('[data-testid="tray-save-message"]');
  if (msg instanceof HTMLElement) {
    const box = msg.getBoundingClientRect();
    if (clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return "message";
  }
  const strip = document.querySelector('[data-testid="day-strip"]');
  if (strip instanceof HTMLElement) {
    const box = strip.getBoundingClientRect();
    if (clientY >= box.top && clientY <= box.bottom && clientX >= box.left && clientX <= box.right) return "strip";
  }
  for (const sel of [".tray-save-message", ".v3-tray", ".tray-sheet"]) {
    const node = document.querySelector(sel);
    if (!(node instanceof HTMLElement)) continue;
    const box = node.getBoundingClientRect();
    if (clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return "tray";
  }
  return "grid";
}
