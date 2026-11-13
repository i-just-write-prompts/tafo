/** Day/week pager gesture arbitration (AC 26). Complements v3 press-and-hold drag. */

import { HOLD_MS } from "../v3/gesture";

export const MOVE_THRESHOLD_PT = 10;
export const SWIPE_ANGLE_DEG = 30;
export const EDGE_EXCLUSION_PT = 20;
export const SWIPE_COMMIT_RATIO = 0.3;

export type PanKind = "undecided" | "scroll" | "swipe" | "hold-drag" | "edge-excluded";

export interface PanPoint {
  x: number;
  y: number;
}

export interface PanGesture {
  pointerId: number;
  origin: PanPoint;
  point: PanPoint;
  startedAt: number;
  kind: PanKind;
  screenWidth: number;
}

export function panDown(pointerId: number, point: PanPoint, screenWidth: number, now: number): PanGesture {
  const kind = isEdgeExcluded(point.x, screenWidth) ? "edge-excluded" : "undecided";
  return { pointerId, origin: point, point, startedAt: now, kind, screenWidth };
}

export function isEdgeExcluded(x: number, screenWidth: number): boolean {
  return x <= EDGE_EXCLUSION_PT || x >= screenWidth - EDGE_EXCLUSION_PT;
}

export function classifyMove(dx: number, dy: number): "none" | "horizontal" | "vertical" {
  const dist = Math.hypot(dx, dy);
  if (dist <= MOVE_THRESHOLD_PT) return "none";
  const angleDeg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  return angleDeg <= SWIPE_ANGLE_DEG ? "horizontal" : "vertical";
}

export function panMove(gesture: PanGesture, point: PanPoint, now: number): PanGesture {
  if (gesture.kind === "edge-excluded") return { ...gesture, point };
  const next = { ...gesture, point };
  if (gesture.kind === "hold-drag" || gesture.kind === "scroll" || gesture.kind === "swipe") {
    return next;
  }
  if (now - gesture.startedAt >= HOLD_MS) {
    return { ...next, kind: "hold-drag" };
  }
  const dx = point.x - gesture.origin.x;
  const dy = point.y - gesture.origin.y;
  const direction = classifyMove(dx, dy);
  if (direction === "horizontal") return { ...next, kind: "swipe" };
  if (direction === "vertical") return { ...next, kind: "scroll" };
  return next;
}

/** True when the pager should commit to the next page (AC 25: past 30% of width or flick). */
export function swipeShouldCommit(offsetX: number, width: number, velocityX = 0): boolean {
  if (width <= 0) return false;
  if (Math.abs(offsetX) / width >= SWIPE_COMMIT_RATIO) return true;
  return Math.abs(velocityX) >= 0.65;
}
