// Shopee Seller (shop) module tests against a real SQLite database built from the repo schema and migrations.
// Shopee's Open Platform is mocked: no request leaves the test process, and only the token endpoints and the
// read-only get_shop_info endpoint may be called. Nothing is created, edited or ordered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { buildShopeeSellerAuthorizationUrl, shopeeSellerSign, shopeeSellerGet, shopeeSellerConfigured, shopeeSellerHost, SHOPEE_SELLER_READ_ONLY_PATHS } from "../cloudflare/worker.mjs";

const BASE = "https://social-api.siamhrbp.com/api/social-commerce";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(7);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const PARTNER = { SHOPEE_PARTNER_ID: "2001234", SHOPEE_PARTNER_KEY: "partner-key-test" };
const hex = (msg) => createHmac("sha256", PARTNER.SHOPEE_PARTNER_KEY).update(msg).digest("hex");

function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a.map(v => v === undefined ? null : v); return o; },
        async first() { return st.get(...args) ?? null; },
        async all() { return { results: st.all(...args) }; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; }
      };
      return o;
    }
  };
}

async function setup(extraEnv = {}, { withMigration = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql"];
  if (withMigration) files.push("../migrations/0009_shopee_seller_shops.sql");
  for (const f of files) db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  const env = { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), ...PARTNER, ...extraEnv };
  return { db, env };
}

const api = (path, method = "GET", body) => new Request(BASE + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined
});

// Fake Shopee Open Platform. Fails the test on any path other than token get/refresh and get_shop_info.
function shopee(t, { tokenError = null, expireIn = 14400 } = {}) {
  const calls = [];
  let issued = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://partner.shopeemobile.com", "only Shopee's live partner host may be called");
    const ts = u.searchParams.get("timestamp");
    if (u.pathname === "/api/v2/auth/token/get" || u.pathname === "/api/v2/auth/access_token/get") {
      assert.equal(init.method, "POST");
      assert.equal(u.searchParams.get("sign"), hex(PARTNER.SHOPEE_PARTNER_ID + u.pathname + ts), "public API signature");
      const body = JSON.parse(String(init.body));
      calls.push({ kind: u.pathname === "/api/v2/auth/token/get" ? "token" : "refresh", body });
      assert.equal(body.partner_id, 2001234);
      if (tokenError) return Response.json({ error: "error_auth", message: tokenError, request_id: "r" });
      issued++;
      return Response.json({ access_token: "sat." + issued, refresh_token: "srt." + issued, expire_in: expireIn, error: "", message: "", request_id: "r" + issued });
    }
    if (u.pathname === "/api/v2/shop/get_shop_info") {
      assert.equal(init.method, "GET");
      const at = u.searchParams.get("access_token"), shopId = u.searchParams.get("shop_id");
      assert.equal(u.searchParams.get("sign"), hex(PARTNER.SHOPEE_PARTNER_ID + u.pathname + ts + at + shopId), "shop API signature");
      calls.push({ kind: "shop_info", at, shopId });
      return Response.json({ shop_name: "Siam Test Shop", region: "TH", status: "NORMAL", error: "", message: "", request_id: "s" });
    }
    throw new Error("unexpected Shopee request " + u.pathname);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function connect(env, shopId = "778899") {
  const start = await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), env);
  assert.equal(start.status, 200);
  const data = await start.json();
  const redirect = new URL(new URL(data.authorization_url).searchParams.get("redirect"));
  const state = redirect.searchParams.get("state");
  const cb = await worker.fetch(new Request(redirect.toString() + "&code=abc123&shop_id=" + shopId), env);
  return { start: data, state, html: await cb.text() };
}

test("signatures follow Shopee Open Platform v2 (public and shop APIs)", async () => {
  assert.equal(await shopeeSellerSign(PARTNER, "/api/v2/shop/auth_partner", 1700000000), hex("2001234/api/v2/shop/auth_partner1700000000"));
  assert.equal(await shopeeSellerSign(PARTNER, "/api/v2/shop/get_shop_info", 1700000000, "tok", "55"), hex("2001234/api/v2/shop/get_shop_info1700000000tok55"));
});

test("authorization URL uses auth_partner on the live host with the redirect carrying state", async () => {
  const u = new URL(await buildShopeeSellerAuthorizationUrl(PARTNER, "STATE1", 1700000000));
  assert.equal(u.origin + u.pathname, "https://partner.shopeemobile.com/api/v2/shop/auth_partner");
  assert.equal(u.searchParams.get("partner_id"), "2001234");
  assert.equal(u.searchParams.get("timestamp"), "1700000000");
  assert.equal(u.searchParams.get("sign"), hex("2001234/api/v2/shop/auth_partner1700000000"));
  const r = new URL(u.searchParams.get("redirect"));
  assert.equal(r.origin + r.pathname, "https://social-api.siamhrbp.com/api/social-commerce/oauth/shopee-seller/callback");
  assert.equal(r.searchParams.get("state"), "STATE1");
  assert.equal(u.toString().includes("partner-key-test"), false, "the partner key never goes to the browser");
  assert.equal(shopeeSellerHost({ SHOPEE_ENV: "sandbox" }), "https://partner.test-stable.shopeemobile.com");
  assert.equal(shopeeSellerConfigured({ SHOPEE_PARTNER_ID: "abc", SHOPEE_PARTNER_KEY: "k" }), false);
});

test("not configured: health, start and shop list say so, and nothing calls Shopee", async (t) => {
  const calls = shopee(t);
  const { env } = await setup({ SHOPEE_PARTNER_ID: "", SHOPEE_PARTNER_KEY: "" });
  const health = await (await worker.fetch(new Request(BASE + "/health"), env)).json();
  assert.equal(health.shopee_seller_configured, false);
  assert.equal(health.shopee_seller_read_only, true);
  assert.equal(health.platforms.shopee_seller, "oauth_not_configured");
  assert.equal(health.platforms.shopee_affiliate, "awaiting_api_approval", "Affiliate stays a separate platform with its own status");
  assert.equal((await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), env)).status, 503);
  const list = await (await worker.fetch(api("/shopee-seller/shops"), env)).json();
  assert.deepEqual(list, { configured: false, environment: "live", read_only: true, shops: [] });
  assert.equal(calls.length, 0);
});

test("start requires a Dashboard session", async () => {
  const { env } = await setup();
  assert.equal((await worker.fetch(new Request(BASE + "/oauth/shopee-seller/start", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(BASE + "/shopee-seller/shops"), env)).status, 401);
});

test("shop authorization stores the shop with encrypted tokens, outside social_accounts", async (t) => {
  const calls = shopee(t);
  const { db, env } = await setup();
  const { html } = await connect(env);
  assert.match(html, /เชื่อมต่อ Shopee Seller สำเร็จ/);
  assert.deepEqual(calls.map(c => c.kind), ["token", "shop_info"]);
  assert.deepEqual(calls[0].body, { code: "abc123", shop_id: 778899, partner_id: 2001234 });
  const row = db.prepare("SELECT * FROM shopee_seller_shops").get();
  assert.equal(row.shop_name, "Siam Test Shop");
  assert.equal(row.region, "TH");
  assert.equal(row.status, "connected");
  assert.notEqual(row.encrypted_access_token, "sat.1", "tokens are encrypted at rest");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0);
  const list = await (await worker.fetch(api("/shopee-seller/shops"), env)).json();
  assert.equal(list.shops.length, 1);
  assert.equal(JSON.stringify(list).includes("encrypted"), false, "tokens are never returned");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM oauth_states").get().n, 0, "state is single-use");
});

test("callback rejects a replayed or unknown state and a missing shop_id", async (t) => {
  shopee(t);
  const { env } = await setup();
  const { state } = await connect(env);
  const replay = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?state=" + encodeURIComponent(state) + "&code=abc&shop_id=1"), env);
  assert.match(await replay.text(), /invalid or expired/);
  const start = await (await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), env)).json();
  const fresh = new URL(new URL(start.authorization_url).searchParams.get("redirect")).searchParams.get("state");
  const noShop = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?state=" + encodeURIComponent(fresh) + "&code=abc&main_account_id=9"), env);
  assert.match(await noShop.text(), /Only shop authorization/);
});

test("token errors are recorded and nothing is saved", async (t) => {
  shopee(t, { tokenError: "Invalid code" });
  const { db, env } = await setup({}, { withMigration: true });
  const { html } = await connect(env);
  assert.match(html, /token_exchange/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shopee_seller_shops").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='shopee_seller_oauth_failed'").get().n, 1);
});

test("verify reads shop info, refreshing an expiring token first; disconnect clears tokens", async (t) => {
  const calls = shopee(t, { expireIn: 60 });
  const { db, env } = await setup({}, { withMigration: true });
  await connect(env);
  const id = db.prepare("SELECT id FROM shopee_seller_shops").get().id;
  const v = await worker.fetch(api("/shopee-seller/shops/" + id + "/verify", "POST", {}), env);
  assert.equal(v.status, 200);
  const body = await v.json();
  assert.equal(body.connected, true);
  assert.equal(body.shop_name, "Siam Test Shop");
  assert.deepEqual(calls.map(c => c.kind), ["token", "shop_info", "refresh", "shop_info"]);
  assert.equal(calls[3].at, "sat.2", "the refreshed token is used");
  const d = await worker.fetch(api("/shopee-seller/shops/" + id, "DELETE"), env);
  assert.equal((await d.json()).status, "disconnected");
  const row = db.prepare("SELECT status,encrypted_access_token,encrypted_refresh_token FROM shopee_seller_shops WHERE id=?").get(id);
  assert.deepEqual({ ...row }, { status: "disconnected", encrypted_access_token: null, encrypted_refresh_token: null });
});

test("read-only allowlist: any non-allowlisted Shopee path is refused before a request is made", async (t) => {
  const calls = shopee(t);
  assert.deepEqual([...SHOPEE_SELLER_READ_ONLY_PATHS], ["/api/v2/shop/get_shop_info"]);
  for (const path of ["/api/v2/product/update_item", "/api/v2/product/add_item", "/api/v2/order/cancel_order", "/api/v2/logistics/ship_order"]) {
    await assert.rejects(shopeeSellerGet(PARTNER, path, "tok", "1"), /read-only allowlist/);
  }
  assert.equal(calls.length, 0);
});

test("migration 0009 matches the table the Worker creates (idempotent)", async (t) => {
  shopee(t);
  const { db, env } = await setup({}, { withMigration: true });
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='shopee_seller_shops'").get().sql;
  await connect(env);
  const cols = db.prepare("PRAGMA table_info(shopee_seller_shops)").all().map(c => c.name);
  assert.deepEqual(cols, ["id", "owner_user_id", "shop_id", "shop_name", "region", "shop_status", "environment", "status", "token_expires_at", "refresh_expires_at", "encrypted_access_token", "encrypted_refresh_token", "verified_at", "created_at", "updated_at"]);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='shopee_seller_shops'").get().sql, before);
});
