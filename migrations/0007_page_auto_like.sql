-- "แอดมินโซเชียล" auto-like for the connected Facebook Page's own posts. Safe additive migration.
-- One settings row per connected Page account.
CREATE TABLE IF NOT EXISTS auto_like_settings (
  account_id TEXT PRIMARY KEY REFERENCES social_accounts(id),
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Posts created after this time are liked automatically.
  enabled_at TEXT,
  backfill_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_run_result TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Like ledger: one row per Page + post makes every like idempotent and auditable.
-- status: pending -> liking -> liked | failed | unknown
CREATE TABLE IF NOT EXISTS page_post_likes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  account_id TEXT NOT NULL REFERENCES social_accounts(id),
  page_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  post_created_time TEXT,
  post_permalink TEXT,
  post_message_preview TEXT,
  source TEXT NOT NULL CHECK(source IN ('backfill','auto')),
  status TEXT NOT NULL CHECK(status IN ('pending','liking','liked','failed','unknown')),
  error_message TEXT,
  liked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_page_post_likes_account_created
  ON page_post_likes(account_id, created_at DESC);
