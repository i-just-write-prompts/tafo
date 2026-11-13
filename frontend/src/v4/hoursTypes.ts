export interface CategoryHourSpan {
  domain: "work" | "home" | "personal";
  weekday: number;
  start_minutes: number;
  end_minutes: number;
}

export interface SacredWindow {
  id: string;
  name: string;
  days_mask: number;
  start_minutes: number;
  end_minutes: number;
  agent_block: number;
  heads_up: number;
  version: number;
}

export interface HoursPayload {
  category_hours: CategoryHourSpan[];
  sacred_windows: SacredWindow[];
  summary: string;
}
