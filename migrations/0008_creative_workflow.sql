-- Cloud creative workflow: Master Bot -> Creative Bot -> Graphic Design -> แอดมินโซเชียล. Safe additive migration.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','blocked')),
  -- created -> planned -> creative_done -> graphic_cover -> graphic_illustration -> graphic_banner -> published
  stage TEXT NOT NULL,
  target_account_id TEXT REFERENCES social_accounts(id),
  plan_json TEXT,
  creative_json TEXT,
  content_id TEXT,
  post_id TEXT,
  permalink TEXT,
  error_message TEXT,
  lock_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner_created ON workflow_runs(owner_user_id, created_at DESC);

-- Ordered, timestamped handoff/status events for the real-time activity feed.
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  seq INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

-- Generated images (base64 JPEG) produced by Graphic Design.
CREATE TABLE IF NOT EXISTS workflow_assets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('cover','illustration','banner')),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  data_b64 TEXT NOT NULL,
  fb_photo_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, kind)
);
