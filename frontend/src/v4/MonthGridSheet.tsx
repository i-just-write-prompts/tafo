import { useMemo } from "react";
import type { Domain } from "../types";
import { PlanTime } from "../plan/time";

export type MonthGridDetent = "medium" | "large";

export interface MonthGridDotEvent {
  dayKey: string;
  domain: Domain;
}

export interface MonthGridSheetProps {
  anchorDayKey: string;
  timeZone: string;
  selectedDayKey: string;
  events: MonthGridDotEvent[];
  detent: MonthGridDetent;
  onSelectDate: (dayKey: string) => void;
  onOpenDay: (dayKey: string) => void;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  onToday?: () => void;
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

const DOT_COLOR: Record<Domain, string> = {
  work: "var(--work-line)",
  home: "var(--home-line)",
  personal: "var(--personal-line)",
};

function monthParts(dayKey: string): { year: number; month: number } {
  const [year, month] = dayKey.split("-").map(Number);
  return { year, month };
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function gridCells(anchorDayKey: string): { dayKey: string; inMonth: boolean; day: number }[] {
  const { year, month } = monthParts(anchorDayKey);
  const firstKey = `${year}-${String(month).padStart(2, "0")}-01`;
  const monday = PlanTime.mondayKey(firstKey);
  return Array.from({ length: 42 }, (_, index) => {
    const dayKey = PlanTime.addDaysToKey(monday, index);
    const parts = monthParts(dayKey);
    return { dayKey, inMonth: parts.year === year && parts.month === month, day: Number(dayKey.slice(-2)) };
  });
}

function dotsForDay(events: MonthGridDotEvent[], dayKey: string): Domain[] {
  const seen = new Set<Domain>();
  const out: Domain[] = [];
  for (const event of events) {
    if (event.dayKey !== dayKey || seen.has(event.domain)) continue;
    seen.add(event.domain);
    out.push(event.domain);
    if (out.length >= 3) break;
  }
  return out;
}

export function MonthGridSheet(props: MonthGridSheetProps) {
  const { year, month } = monthParts(props.anchorDayKey);
  const todayKey = PlanTime.dayKey(new Date(), props.timeZone);
  const cells = useMemo(() => gridCells(props.anchorDayKey), [props.anchorDayKey]);

  return (
    <div
      className="sheet month-grid-sheet"
      data-detent={props.detent}
      role="dialog"
      aria-label="Jump to date"
    >
      <div className="sheet-grip" />
      <header className="month-grid-head">
        <h2>Jump to date</h2>
        {props.onToday ? (
          <button type="button" className="month-grid-today" onClick={props.onToday}>
            Today
          </button>
        ) : null}
      </header>
      <div className="month-grid-nav">
        <span>{monthLabel(year, month)}</span>
        <div className="month-grid-arrows">
          <button
            type="button"
            aria-label="Previous month"
            className="month-grid-arrow"
            onClick={props.onPrevMonth}
          />
          <button
            type="button"
            aria-label="Next month"
            className="month-grid-arrow next"
            onClick={props.onNextMonth}
          />
        </div>
      </div>
      <div className="month-grid-weekdays" aria-hidden>
        {WEEKDAYS.map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </div>
      <div className="month-grid-cells">
        {cells.map((cell) => {
          const selected = cell.dayKey === props.selectedDayKey;
          const today = cell.dayKey === todayKey && !selected;
          const dots = dotsForDay(props.events, cell.dayKey);
          const dayNum = Number(cell.dayKey.slice(-2));
          return (
            <button
              key={cell.dayKey}
              type="button"
              className={[
                "month-grid-cell",
                cell.inMonth ? "in-month" : "out-month",
                selected ? "selected" : "",
                today ? "today-ring" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={`${cell.dayKey}${selected ? ", selected" : ""}${today ? ", today" : ""}`}
              onClick={() => props.onSelectDate(cell.dayKey)}
            >
              <span className="month-grid-day">{dayNum}</span>
              <span className="month-grid-dots" aria-hidden>
                {dots.map((domain) => (
                  <i key={domain} style={{ background: DOT_COLOR[domain] }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {props.detent === "large" ? (
        <footer className="month-grid-footer">
          <button type="button" className="month-grid-open" onClick={() => props.onOpenDay(props.selectedDayKey)}>
            Open day ›
          </button>
        </footer>
      ) : null}
    </div>
  );
}
