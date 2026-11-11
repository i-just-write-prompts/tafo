export type Domain = "work" | "home" | "personal";
export type Status = "todo" | "doing" | "waiting" | "done";
export type View = "all" | "work" | "life";
export type Tab = "plan" | "today" | "backlog" | "inbox" | "calendar" | "week";

export interface Subtask {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  sort_order: number;
  version: number;
}

export interface Task {
  id: string;
  title: string;
  domain: Domain;
  status: Status;
  estimate_hours: number | null;
  due_date: string | null;
  notes: string;
  sort_order: number;
  on_today: boolean;
  version: number;
  created_at?: string;
  subtasks: Subtask[];
  tracked_seconds: number;
  progress: {
    checklist_done: number;
    checklist_total: number;
    estimate_hours: number | null;
    tracked_hours: number;
  };
}

export interface Meta {
  name: string;
  tagline: string;
  calendar_mode: "demo" | "live";
  sync_label: string;
  display_timezone: string;
  google_configured: boolean;
  work_invite_configured: boolean;
  manager_access: string;
  outlook_gap: string;
  notices: string[];
  filter_note: string;
  version?: string;
  human_edits_auto_approve?: boolean;
  preview?: boolean;
  preview_banner?: string;
}

export interface BusyInterval {
  source: string;
  summary: string;
  starts_at: string;
  ends_at: string;
  tafo_event_key: string | null;
}

export interface Availability {
  read_source: string;
  read_error: string | null;
  external_busy: BusyInterval[];
  suppressed_mirrors: BusyInterval[];
  orphan_app_blocks: BusyInterval[];
  outlook_gap: string;
  conflict_free: boolean;
}

export interface Proposal {
  id: string;
  source: string;
  source_kind: string;
  kind: string;
  status: string;
  explanation: string;
  payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
  availability: Availability | null;
  version: number;
  touches_fixed?: boolean;
}

export interface CalendarBlock {
  id: string;
  task_id: string | null;
  origin_proposal_id?: string | null;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  domain: Domain;
  invite_work_email: boolean;
  fixed: boolean;
  status: string;
  sync_state: string;
  written_mode: string;
  honest_label: string;
  google_event_id: string | null;
  version: number;
}

export interface OutboxStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface OutboxOperation {
  id: string;
  proposal_id: string;
  operation: string;
  event_key: string;
  status: string;
  mode: string;
  attempt_count: number;
  google_event_id: string | null;
  last_error: string | null;
  honest_label: string;
  result: { steps: OutboxStep[] } | null;
}

export interface WeekSummary {
  week_start: string;
  bullets: string;
  version: number;
  timezone: string;
}

export interface TimerSession {
  id: string;
  task_id: string;
  task_title: string | null;
  started_at: string;
  ended_at: string | null;
  running: boolean;
  elapsed_seconds: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity_type: string;
  detail: Record<string, unknown>;
}

export interface Suggestion {
  starts_local: string;
  ends_local: string;
  avoided_known_conflicts: boolean;
  outlook_gap: string;
}
