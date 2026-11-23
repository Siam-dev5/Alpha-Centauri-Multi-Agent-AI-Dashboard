-- Shopee Seller (shop owner) module: authorized shops, read-only. Safe additive migration (new table only).
-- Apply only when the Shopee Open Platform app is ready and the seller is about to authorize:
--   wrangler d1 migrations apply <db> --remote
CREATE TABLE IF NOT EXISTS shopee_shops (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  region TEXT,
  shop_status TEXT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','disconnected','expired','error')),
  auth_expire_at TEXT,
  token_expires_at TEXT,
  refresh_expires_at TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, shop_id)
);
CREATE INDEX IF NOT EXISTS idx_shopee_shops_owner ON shopee_shops(owner_user_id);
