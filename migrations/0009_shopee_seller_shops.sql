-- Shopee Seller (shop) module: shops authorized through Shopee Open Platform v2 (read-only use).
-- Kept separate from social_accounts/'shopee_affiliate' (Affiliate Open API is a different program).
-- Additive only. The Worker also runs this same CREATE TABLE IF NOT EXISTS before using the table.
CREATE TABLE IF NOT EXISTS shopee_seller_shops (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES app_users(id),
  shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  region TEXT,
  shop_status TEXT,
  environment TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','disconnected','expired','error')),
  token_expires_at TEXT,
  refresh_expires_at TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, shop_id, environment)
);
