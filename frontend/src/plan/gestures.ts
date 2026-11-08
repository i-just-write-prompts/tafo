import { PX_PER_MINUTE, SNAP_MINUTES, PlanTime } from "./time";

export class PlanGestures {
  static dropStart(pointerY: number, columnTop: number, grabMin: number, dayMinutes: number): number {
    const pointerMin = (pointerY - columnTop) / PX_PER_MINUTE;
    const snapped = PlanTime.snapMinutes(pointerMin - grabMin);
    const latest = Math.max(0, dayMinutes - SNAP_MINUTES);
    return Math.min(Math.max(snapped, 0), latest);
  }

  static resizeEnd(pointerY: number, columnTop: number, startMin: number, dayMinutes: number): number {
    const pointerMin = (pointerY - columnTop) / PX_PER_MINUTE;
    const snapped = PlanTime.snapMinutes(pointerMin);
    return Math.min(Math.max(snapped, startMin + SNAP_MINUTES), dayMinutes);
  }
}

export class PlanHit {
  static column(scroller: HTMLElement, x: number, y: number): { dayKey: string; top: number } | null {
    const view = scroller.getBoundingClientRect();
    if (x < view.left || x > view.right || y < view.top || y > view.bottom) return null;
    const columns = scroller.querySelectorAll<HTMLElement>("[data-day]");
    for (const column of columns) {
      const rect = column.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        const dayKey = column.dataset.day;
        if (dayKey) return { dayKey, top: rect.top };
      }
    }
    return null;
  }
}
