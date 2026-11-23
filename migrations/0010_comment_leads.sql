-- "เลขาส่วนตัว" (Personal Secretary): people who commented the CTA keyword under the Page's workflow posts,
-- and the single Facebook Private Reply each of them may receive. Safe additive migration (new table only).
-- status: pending -> sending -> sent | failed | unknown ; skipped (not eligible: expired, not allow-listed, ...)
CREATE TABLE IF NOT EXISTS comment_leads (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  account_id TEXT NOT NULL REFERENCES social_accounts(id),
  page_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  comment_id TEXT NOT NULL UNIQUE,
  commenter_id TEXT,
  commenter_name TEXT,
  comment_text TEXT,
  comment_created_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','skipped')),
  reason TEXT,
  message_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_leads_owner_created ON comment_leads(owner_user_id, created_at DESC);
