CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram','youtube','tiktok','shopee_affiliate','lazada_affiliate')),
  external_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  profile_picture_url TEXT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','disconnected','expired','error')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, platform, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner_platform ON social_accounts(owner_user_id,platform);
CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  affiliate_url TEXT,
  disclosure TEXT NOT NULL DEFAULT '',
  platforms_json TEXT NOT NULL,
  account_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','rejected','scheduled','published','failed')),
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_owner_status ON content_items(owner_user_id,status,updated_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_owner_created ON audit_events(owner_user_id,created_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  platform TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
