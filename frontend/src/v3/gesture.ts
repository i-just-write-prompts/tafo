/** Press-and-hold lifts a block. A move before the hold stays a scroll. */

export const HOLD_MS = 300;
export const CANCEL_PX = 8;
export const COMMIT_PX = 4;

export interface Point {
  x: number;
  y: number;
}

export interface PendingGesture {
  phase: "pending";
  pointerId: number;
  eventId: string;
  origin: Point;
  point: Point;
  started: number;
}

export interface LiftedGesture {
  phase: "lifted";
  pointerId: number;
  eventId: string;
  origin: Point;
  point: Point;
  started: number;
}

export type Gesture = { phase: "idle" } | PendingGesture | LiftedGesture;

export function gestureDown(pointerId: number, eventId: string, point: Point, now: number): PendingGesture {
  return { phase: "pending", pointerId, eventId, origin: point, point, started: now };
}

export function holdReady(gesture: Gesture, now: number): Gesture {
  if (gesture.phase !== "pending") return gesture;
  if (now - gesture.started < HOLD_MS) return gesture;
  return { ...gesture, phase: "lifted" };
}

export function gestureMove(gesture: Gesture, point: Point, now = 0): Gesture {
  if (gesture.phase === "idle") return gesture;
  const distance = Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y);
  if (gesture.phase === "pending") {
    if (now - gesture.started >= HOLD_MS) return { ...gesture, phase: "lifted", point };
    if (distance > CANCEL_PX) return { phase: "idle" };
  }
  return { ...gesture, point };
}

export function gestureUp(gesture: Gesture): { gesture: Gesture; commit: boolean; tap: boolean } {
  if (gesture.phase === "lifted") {
    const distance = Math.hypot(gesture.point.x - gesture.origin.x, gesture.point.y - gesture.origin.y);
    return { gesture: { phase: "idle" }, commit: distance >= COMMIT_PX, tap: distance < COMMIT_PX };
  }
  if (gesture.phase === "pending") {
    return { gesture: { phase: "idle" }, commit: false, tap: true };
  }
  return { gesture, commit: false, tap: false };
}

export function samePointer(gesture: Gesture, pointerId: number): boolean {
  return gesture.phase !== "idle" && gesture.pointerId === pointerId;
}
