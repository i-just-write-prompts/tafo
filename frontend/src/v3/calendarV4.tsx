/** v4 slice 1 wiring helpers used by CalendarShell. */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { PX_PER_MINUTE } from "../plan/time";
import { dayHourRows, minutesToY, weekHourRows, type DayHourRow } from "../v4/dayRange";
import { panDown, panMove, swipeShouldCommit, type PanGesture, type PanKind } from "../v4/swipe";
import { dayName, dayTitle } from "./format";
import { DAY_GUTTER, WEEK_GUTTER } from "./geometry";

export { crossDayHoverCell, crossDayRelease, crossDayStripEnter, crossDayStripLeave } from "../v4/crossDay";

export function stripCellId(dayKey: string): string {
  return `strip-cell-${dayName(dayKey).toLowerCase()}`;
}

export function crossDayMoveLabel(title: string, dayKey: string, startHour: number): string {
  const hh = Math.trunc(startHour);
  const mm = Math.round((startHour - hh) * 60);
  const body = mm ? `${hh % 12 || 12}:${String(mm).padStart(2, "0")}` : `${hh % 12 || 12}`;
  const suffix = hh < 12 ? "AM" : "PM";
  return `${title} → ${dayName(dayKey)} ${body} ${suffix}`;
}

export function scrollHourAttr(scrollTop: number): string {
  return String(Math.floor(scrollTop / PX_PER_MINUTE / 60));
}

export function useScrollHour(gridRef: RefObject<HTMLDivElement | null>): string {
  const [hour, setHour] = useState("9");
  useEffect(() => {
    const node = gridRef.current;
    if (!node) return undefined;
    const read = () => setHour(scrollHourAttr(node.scrollTop));
    read();
    node.addEventListener("scroll", read, { passive: true });
    return () => node.removeEventListener("scroll", read);
  }, [gridRef]);
  return hour;
}

export function useGridPager(options: {
  width: number;
  enabled: boolean;
  onPrev: () => void;
  onNext: () => void;
}): {
  panKind: PanKind;
  offsetX: number;
  onPagerPointerDown: (e: React.PointerEvent, gridLeft: number, gridScroll: number) => boolean;
  dataEnabled: boolean;
} {
  const gestureRef = useRef<PanGesture | null>(null);
  const [panKind, setPanKind] = useState<PanKind>("undecided");
  const [offsetX, setOffsetX] = useState(0);

  const onPagerPointerDown = useCallback(
    (e: React.PointerEvent, gridLeft: number, gridScroll: number) => {
      if (!options.enabled || e.button !== 0) return false;
      const point = { x: e.clientX - gridLeft, y: e.clientY };
      const g = panDown(e.pointerId, point, options.width, performance.now());
      if (g.kind === "edge-excluded") {
        setPanKind("edge-excluded");
        return true;
      }
      gestureRef.current = g;
      setPanKind("undecided");
      const pointerId = e.pointerId;
      const originY = e.clientY;
      let velocityX = 0;
      let lastX = e.clientX;
      let lastT = performance.now();
      let scrolling = false;

      function move(native: PointerEvent) {
        if (native.pointerId !== pointerId || !gestureRef.current) return;
        const dt = native.timeStamp - lastT;
        if (dt > 0) velocityX = (native.clientX - lastX) / dt;
        lastX = native.clientX;
        lastT = native.timeStamp;
        const p = { x: native.clientX - gridLeft, y: native.clientY };
        const next = panMove(gestureRef.current, p, native.timeStamp);
        gestureRef.current = next;
        setPanKind(next.kind);
        if (next.kind === "swipe") {
          setOffsetX(native.clientX - gridLeft - next.origin.x);
        } else if (next.kind === "scroll") {
          scrolling = true;
          const grid = document.querySelector<HTMLElement>('[data-testid="day-grid"], [data-testid="week-grid"]');
          if (grid) grid.scrollTop = gridScroll - (native.clientY - originY);
        } else if (next.kind === "hold-drag") {
          return;
        }
      }

      function up(native: PointerEvent) {
        if (native.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        const g = gestureRef.current;
        if (!g) return;
        const dx = native.clientX - gridLeft - g.origin.x;
        if (g.kind === "swipe" && swipeShouldCommit(dx, options.width, velocityX)) {
          if (dx < 0) options.onNext();
          else options.onPrev();
        }
        setOffsetX(0);
        gestureRef.current = null;
        if (!scrolling) setPanKind(g.kind);
      }

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return true;
    },
    [options],
  );

  return { panKind, offsetX, onPagerPointerDown, dataEnabled: options.enabled };
}

export function HourRows(props: {
  rows: DayHourRow[];
  width: number;
  mode: "day" | "week";
  dayKey?: string;
}) {
  const gutter = props.mode === "day" ? DAY_GUTTER : WEEK_GUTTER;
  return (
    <>
      {props.rows.map((row, index) => {
        const top = minutesToY(row.startMinutes);
        const repeated1am = row.repeated && row.hour === 1;
        const testId = repeated1am
          ? "hour-row-1am-repeated"
          : props.mode === "week" && row.hour === 1 && !row.repeated
            ? "week-hour-row-1am-folded"
            : row.hour === 0
              ? "hour-row-0"
              : index === props.rows.length - 1
                ? "hour-row-last"
                : `hour-row-${row.hour}`;
        return (
          <div key={`${row.index}-${row.startMinutes}`} data-testid={testId} data-hour={String(row.hour)} data-repeated={row.repeated ? "1" : "0"} data-skipped={row.skipped ? "1" : "0"}>
            {!row.skipped ? (
              <>
                <div className="hour-line" style={{ top }} />
                <div
                  className="hour-label"
                  style={
                    props.mode === "week"
                      ? { top, left: 0, width: gutter, textAlign: "right", paddingRight: 4 }
                      : { top, right: props.width - gutter + 8 }
                  }
                >
                  {row.label}
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function dayRowsFor(dayKey: string, timeZone: string): DayHourRow[] {
  return dayHourRows(dayKey, timeZone);
}

export function weekRowsFor(mondayKey: string, timeZone: string): DayHourRow[] {
  return weekHourRows(mondayKey, timeZone);
}

export function NextDayRow(props: { nextKey: string; onOpen: () => void }) {
  return (
    <div className="next-day-row" data-testid="next-day-link">
      <button type="button" onClick={props.onOpen}>
        {dayTitle(props.nextKey)} ›
      </button>
    </div>
  );
}

export function NowChip(props: { label: string; onJump: () => void }) {
  return (
    <button type="button" className="now-chip" data-testid="now-chip" onClick={props.onJump}>
      Now {props.label}
    </button>
  );
}

export function CrossDayBanner(props: { originDayKey: string; viewDayKey: string }) {
  if (props.viewDayKey === props.originDayKey) return null;
  return (
    <p className="cross-day-marker" data-testid="cross-day-marker">
      from {dayName(props.originDayKey)}
    </p>
  );
}

export function DwellRing(props: { progress: number }) {
  if (props.progress <= 0) return null;
  return <span className="strip-dwell-ring" data-testid="strip-dwell-ring" data-progress={String(props.progress)} />;
}

export function ReentryHint(props: { show: boolean; originDayKey: string }) {
  if (!props.show) return null;
  return (
    <p className="cross-day-reentry-hint" data-testid="cross-day-reentry-hint">
      Hold {dayName(props.originDayKey)} to open
    </p>
  );
}
