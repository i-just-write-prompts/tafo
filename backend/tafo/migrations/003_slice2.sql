-- Slice 2: category hours, sacred windows, feedback idempotency (additive).

CREATE TABLE IF NOT EXISTS category_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL CHECK (domain IN ('work', 'home', 'personal')),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minutes INTEGER NOT NULL CHECK (start_minutes >= 0 AND start_minutes < 24 * 60),
  end_minutes INTEGER NOT NULL CHECK (end_minutes > 0 AND end_minutes <= 24 * 60),
  CHECK (end_minutes > start_minutes)
);

CREATE TABLE IF NOT EXISTS sacred_windows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  days_mask INTEGER NOT NULL,
  start_minutes INTEGER NOT NULL,
  end_minutes INTEGER NOT NULL,
  agent_block INTEGER NOT NULL DEFAULT 1 CHECK (agent_block IN (0, 1)),
  heads_up INTEGER NOT NULL DEFAULT 1 CHECK (heads_up IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_submissions (
  client_id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  context_json TEXT NOT NULL,
  screenshot_path TEXT,
  github_issue_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'not_configured')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_category_hours_domain ON category_hours(domain, weekday);
