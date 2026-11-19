-- Meta OAuth and webhook support for Alpha Centauri Social Commerce.
-- oauth_states and social_accounts already exist in the production D1 schema.
CREATE TABLE IF NOT EXISTS meta_webhook_events (
  id TEXT PRIMARY KEY,
  event_hash TEXT NOT NULL UNIQUE,
  object_type TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_webhook_received
  ON meta_webhook_events(received_at DESC);
