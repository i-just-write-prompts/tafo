CREATE INDEX IF NOT EXISTS idx_tasks_domain_status ON tasks(domain, status);
CREATE INDEX IF NOT EXISTS idx_tasks_today_sort ON tasks(on_today, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_span ON calendar_blocks(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_event ON outbox_operations(event_key);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
