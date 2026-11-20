-- Facebook Page publishing support. Safe additive migration.
ALTER TABLE social_accounts ADD COLUMN page_tasks_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS publish_records (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  content_id TEXT NOT NULL REFERENCES content_items(id),
  account_id TEXT NOT NULL REFERENCES social_accounts(id),
  platform TEXT NOT NULL CHECK(platform='facebook'),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('publishing','published','failed','unknown')),
  external_post_id TEXT,
  permalink TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(content_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_publish_records_owner_created
  ON publish_records(owner_user_id, created_at DESC);
