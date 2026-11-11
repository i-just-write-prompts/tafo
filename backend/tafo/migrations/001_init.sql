CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('work', 'home', 'personal')),
  status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'waiting', 'done')),
  estimate_hours REAL,
  due_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  on_today INTEGER NOT NULL DEFAULT 0 CHECK (on_today IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  sort_order INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS timer_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS weekly_summaries (
  week_start TEXT PRIMARY KEY,
  bullets TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('agent', 'human')),
  kind TEXT NOT NULL CHECK (kind IN ('task_change', 'calendar_block', 'calendar_update', 'calendar_cancel')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  explanation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  edited_payload_json TEXT,
  target_task_id TEXT,
  target_block_id TEXT,
  availability_json TEXT,
  idempotency_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  origin_proposal_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('work', 'home', 'personal')),
  invite_work_email INTEGER NOT NULL DEFAULT 0 CHECK (invite_work_email IN (0, 1)),
  fixed INTEGER NOT NULL DEFAULT 0 CHECK (fixed IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled')),
  sync_state TEXT NOT NULL CHECK (sync_state IN ('simulated', 'synced', 'not_synced', 'partial')),
  written_mode TEXT NOT NULL CHECK (written_mode IN ('demo', 'live')),
  honest_label TEXT NOT NULL,
  google_event_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (written_mode <> 'demo' OR sync_state <> 'synced'),
  CHECK (written_mode <> 'demo' OR google_event_id IS NULL)
);

CREATE TABLE IF NOT EXISTS outbox_operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'cancel')),
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'simulated', 'synced', 'failed', 'partial')),
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  google_event_id TEXT,
  last_error TEXT,
  honest_label TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mode <> 'demo' OR status <> 'synced'),
  CHECK (mode <> 'demo' OR google_event_id IS NULL)
);
