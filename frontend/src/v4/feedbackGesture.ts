/** Two-finger hold (~600 ms) for feedback; cooperates with the v3 one-finger hold path. */

export const FEEDBACK_HOLD_MS = 600;
export const FEEDBACK_PAIR_MS = 250;
export const FEEDBACK_MOVE_PX = 10;

interface ActivePointer {
  id: number;
  x: number;
  y: number;
  started: number;
}

export interface FeedbackHoldState {
  pointers: ActivePointer[];
  armed: boolean;
  startedAt: number | null;
}

export function feedbackHoldDown(state: FeedbackHoldState, id: number, x: number, y: number, now: number): FeedbackHoldState {
  const pointers = [...state.pointers.filter((p) => p.id !== id), { id, x, y, started: now }];
  const within = pointers.length === 2 && Math.abs(pointers[0].started - pointers[1].started) <= FEEDBACK_PAIR_MS;
  const close =
    pointers.length === 2
    && Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y) <= FEEDBACK_MOVE_PX;
  return {
    pointers,
    armed: within && close,
    startedAt: within && close ? Math.max(pointers[0].started, pointers[1].started) : state.startedAt,
  };
}

export function feedbackHoldMove(state: FeedbackHoldState, id: number, x: number, y: number): FeedbackHoldState {
  const origin = state.pointers.find((p) => p.id === id);
  if (!origin) return state;
  if (Math.hypot(x - origin.x, y - origin.y) > FEEDBACK_MOVE_PX) {
    return { pointers: [], armed: false, startedAt: null };
  }
  return {
    ...state,
    pointers: state.pointers.map((p) => (p.id === id ? { ...p, x, y } : p)),
  };
}

export function feedbackHoldUp(state: FeedbackHoldState, id: number): FeedbackHoldState {
  return {
    ...state,
    pointers: state.pointers.filter((p) => p.id !== id),
    armed: state.pointers.length > 1,
    startedAt: state.pointers.length > 1 ? state.startedAt : null,
  };
}

export function feedbackHoldReady(state: FeedbackHoldState, now: number): boolean {
  return Boolean(state.armed && state.startedAt != null && now - state.startedAt >= FEEDBACK_HOLD_MS);
}
