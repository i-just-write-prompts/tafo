/** The quick-drag toast keeps Undo for four seconds. */

export const UNDO_MS = 4000;

export interface UndoToast<T> {
  token: number;
  message: string;
  payload: T;
  until: number;
}

export function showUndo<T>(message: string, payload: T, now: number, token: number): UndoToast<T> {
  return { token, message, payload, until: now + UNDO_MS };
}

export function undoExpired<T>(toast: UndoToast<T> | null, now: number): boolean {
  if (!toast) return false;
  return now >= toast.until;
}

export function undoStillThere<T>(toast: UndoToast<T> | null, token: number, now: number): boolean {
  return Boolean(toast && toast.token === token && now < toast.until);
}
