import { DAY_GUTTER, dayY, drawnHeight } from "../v3/geometry";
import type { SacredWindow } from "./hoursTypes";

const SACRED_EDGE = "#958FB0";

export function SacredBands(props: { windows: SacredWindow[]; weekday: number; width: number }) {
  const visible = props.windows.filter((window) => (window.days_mask & (1 << props.weekday)) !== 0);
  return (
    <>
      {visible.map((window) => {
        const start = window.start_minutes / 60;
        const end = window.end_minutes / 60;
        const top = dayY(start);
        const height = drawnHeight(end - start);
        return (
          <div
            key={window.id}
            className="sacred-band"
            data-testid={`sacred-band-${window.id}`}
            style={{ left: DAY_GUTTER, top, height, width: props.width, borderLeftColor: SACRED_EDGE }}
            aria-hidden="true"
          >
            <span>{window.name} · sacred</span>
          </div>
        );
      })}
    </>
  );
}
