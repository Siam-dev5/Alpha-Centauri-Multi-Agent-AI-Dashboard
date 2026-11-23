// Shopee Seller (shop owner) module tests against a real SQLite database built from the repo schema and migrations.
// Shopee Open Platform is mocked: no request leaves the test process, and only the three read-only paths are allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../cloudflare/worker.mjs";
import { shopeeSellerSign, buildShopeeSellerAuthUrl, shopeeSellerCall, shopeeSellerConfigured, SHOPEE_SELLER_ALLOWED_PATHS } from "../cloudflare/shopee_seller.mjs";

const BASE = "https://social-api.siamhrbp.com/api/social-commerce";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const KEY = "shpk_test_partner_key";
const hmac = (s) => createHmac("sha256", KEY).update(s).digest("hex");

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

async function setup({ migrate = true, ...extraEnv } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql"];
  if (migrate) files.push("../migrations/0009_shopee_seller_shops.sql");
  for (const f of files) db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  const env = { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(new Uint8Array(32).fill(9)), SHOPEE_PARTNER_ID: "2001234", SHOPEE_PARTNER_KEY: KEY, ...extraEnv };
  return { db, env };
}
const api = (path, method = "GET", body) => new Request(BASE + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined
});

// Fake Shopee Open Platform: verifies host, allow-listed path and HMAC signature of every call.
function shopee(t, { tokenError = null, refreshError = null, shopStatus = "NORMAL" } = {}) {
  const calls = [];
  let issued = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://partner.shopeemobile.com", "only Shopee's live partner API may be called");
    assert.ok(SHOPEE_SELLER_ALLOWED_PATHS.includes(u.pathname), "only allow-listed read-only paths");
    const pid = u.searchParams.get("partner_id"), ts = u.searchParams.get("timestamp"), sign = u.searchParams.get("sign");
    assert.equal(pid, "2001234");
    assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 300, "timestamp within Shopee's 5-minute window");
    assert.doesNotMatch(String(url) + String(init.body || ""), new RegExp(KEY), "partner key is never sent");
    const at = u.searchParams.get("access_token"), sid = u.searchParams.get("shop_id");
    assert.equal(sign, hmac(pid + u.pathname + ts + (at ? at + sid : "")), "HMAC-SHA256 sign base string per Shopee docs");
    if (u.pathname === "/api/v2/auth/token/get") {
      const body = JSON.parse(init.body);
      calls.push({ kind: "token", body });
      assert.equal(init.method, "POST");
      assert.equal(body.partner_id, 2001234);
      if (tokenError) return Response.json({ error: "error_auth", message: tokenError, request_id: "r" });
      issued++;
      return Response.json({ access_token: "sat." + issued, refresh_token: "srt." + issued, expire_in: 14400, error: "", message: "", request_id: "r" });
    }
    if (u.pathname === "/api/v2/auth/access_token/get") {
      const body = JSON.parse(init.body);
      calls.push({ kind: "refresh", body });
      if (refreshError) return Response.json({ error: "error_auth", message: refreshError, request_id: "r" });
      issued++;
      return Response.json({ access_token: "sat." + issued, refresh_token: "srt." + issued, expire_in: 14400, shop_id: body.shop_id, partner_id: body.partner_id, error: "", message: "", request_id: "r" });
    }
    calls.push({ kind: "shop_info", at, sid, method: init.method });
    assert.equal(init.method, "GET");
    return Response.json({ shop_name: "mccyver", region: "TH", status: shopStatus, is_cb: false, auth_time: 1795000000, expire_time: 1826536000, error: "", message: "", request_id: "r" });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function connect(env, extra = "") {
  const start = await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), env);
  assert.equal(start.status, 200);
  const data = await start.json();
  const state = new URL(data.authorization_url).searchParams.get("state");
  const cb = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?code=abc123&shop_id=88001&state=" + encodeURIComponent(state) + extra), env);
  return { data, state, cb, html: await cb.text() };
}

test("sign matches an independent HMAC-SHA256 and the auth link follows Shopee's new format", async () => {
  assert.equal(await shopeeSellerSign(KEY, "2001234/api/v2/auth/token/get1795000000"), hmac("2001234/api/v2/auth/token/get1795000000"));
  const u = new URL(buildShopeeSellerAuthUrl({ SHOPEE_PARTNER_ID: "2001234", SHOPEE_PARTNER_KEY: KEY }, "ST1"));
  assert.equal(u.origin + u.pathname, "https://open.shopee.com/auth");
  assert.equal(u.searchParams.get("partner_id"), "2001234");
  assert.equal(u.searchParams.get("auth_type"), "seller");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://social-api.siamhrbp.com/api/social-commerce/oauth/shopee-seller/callback");
  assert.equal(u.searchParams.get("state"), "ST1");
  assert.equal(String(u).includes(KEY), false, "the partner key never goes to the browser");
  const sb = new URL(buildShopeeSellerAuthUrl({ SHOPEE_PARTNER_ID: "1", SHOPEE_PARTNER_KEY: "k", SHOPEE_SELLER_ENV: "sandbox" }, "x"));
  assert.equal(sb.origin, "https://open.sandbox.test-stable.shopee.com");
  assert.equal(shopeeSellerConfigured({ SHOPEE_PARTNER_ID: "abc", SHOPEE_PARTNER_KEY: "k" }), false);
});

test("allow-list refuses product, order, logistics and payment endpoints before any request", async (t) => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return Response.json({}); };
  t.after(() => { globalThis.fetch = original; });
  const env = { SHOPEE_PARTNER_ID: "2001234", SHOPEE_PARTNER_KEY: KEY };
  for (const p of ["/api/v2/product/add_item", "/api/v2/product/update_price", "/api/v2/product/update_stock", "/api/v2/order/get_order_list", "/api/v2/order/cancel_order", "/api/v2/logistics/ship_order", "/api/v2/payment/get_escrow_detail", "/api/v2/product/get_item_list"]) {
    await assert.rejects(shopeeSellerCall(env, p, { accessToken: "a", shopId: 1 }), /Blocked Shopee Seller call/);
  }
  assert.equal(fetched, 0);
  assert.deepEqual([...SHOPEE_SELLER_ALLOWED_PATHS], ["/api/v2/auth/token/get", "/api/v2/auth/access_token/get", "/api/v2/shop/get_shop_info"]);
});

test("gating: not configured -> 503; configured but migration missing -> 503; health reports both", async (t) => {
  const calls = shopee(t);
  const none = await setup({ migrate: false, SHOPEE_PARTNER_ID: "", SHOPEE_PARTNER_KEY: "" });
  const h = await (await worker.fetch(new Request(BASE + "/health"), none.env)).json();
  assert.deepEqual({ c: h.shopee_seller.configured, s: h.shopee_seller.schema_ready, m: h.shopee_seller.mode }, { c: false, s: false, m: "read_only" });
  const r1 = await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), none.env);
  assert.equal(r1.status, 503);
  assert.match((await r1.json()).error, /Seller authorization/);
  const noTable = await setup({ migrate: false });
  const r2 = await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), noTable.env);
  assert.equal(r2.status, 503);
  assert.match((await r2.json()).error, /migration 0009/);
  assert.equal(noTable.db.prepare("SELECT COUNT(*) n FROM oauth_states").get().n, 0);
  const list = await (await worker.fetch(api("/shopee-seller/shops"), noTable.env)).json();
  assert.deepEqual(list.shops, []);
  assert.equal(list.schema_ready, false);
  const ready = await setup();
  const h2 = await (await worker.fetch(new Request(BASE + "/health"), ready.env)).json();
  assert.equal(h2.shopee_seller.configured && h2.shopee_seller.schema_ready, true);
  assert.equal(h2.platforms.shopee_affiliate, "awaiting_api_approval", "Affiliate adapter untouched");
  assert.equal(calls.length, 0);
});

test("start and list require a Dashboard session", async () => {
  const { env } = await setup();
  assert.equal((await worker.fetch(new Request(BASE + "/oauth/shopee-seller/start", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(BASE + "/shopee-seller/shops"), env)).status, 401);
});

test("full connect: state used once, code exchanged, shop info read, tokens encrypted, no duplicate on reconnect", async (t) => {
  const { db, env } = await setup();
  const calls = shopee(t);
  const { state, cb, html } = await connect(env);
  assert.equal(cb.status, 200);
  assert.match(html, /ALPHA_CENTAURI_SHOPEE_SELLER_OAUTH/);
  assert.match(html, /connected/);
  assert.deepEqual(calls.map(c => c.kind), ["token", "shop_info"]);
  assert.deepEqual(calls[0].body, { code: "abc123", shop_id: 88001, partner_id: 2001234 });
  const row = db.prepare("SELECT * FROM shopee_shops").get();
  assert.equal(row.shop_id, "88001");
  assert.equal(row.shop_name, "mccyver");
  assert.equal(row.status, "connected");
  assert.equal(row.region, "TH");
  assert.ok(row.auth_expire_at);
  assert.notEqual(row.encrypted_access_token, "sat.1");
  assert.doesNotMatch(row.encrypted_access_token + row.encrypted_refresh_token, /sat\.|srt\./);
  const replay = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?code=abc123&shop_id=88001&state=" + encodeURIComponent(state)), env);
  assert.match(await replay.text(), /invalid or expired/);
  await connect(env);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shopee_shops").get().n, 1);
  const list = await (await worker.fetch(api("/shopee-seller/shops"), env)).json();
  assert.equal(list.shops.length, 1);
  assert.equal(JSON.stringify(list).includes("encrypted"), false, "tokens never leave the Worker");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0, "separate from social/affiliate accounts");
});

test("callback rejects bad state, missing code, main-account-only and token errors without saving", async (t) => {
  const { db, env } = await setup();
  const calls = shopee(t, { tokenError: "invalid code" });
  const bad = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?code=x&shop_id=1&state=forged"), env);
  assert.match(await bad.text(), /invalid or expired/);
  const failed = await connect(env);
  assert.match(failed.html, /token_exchange/);
  const start = await (await worker.fetch(api("/oauth/shopee-seller/start", "POST", {}), env)).json();
  const st = new URL(start.authorization_url).searchParams.get("state");
  const ma = await worker.fetch(new Request(BASE + "/oauth/shopee-seller/callback?code=abc&main_account_id=777&state=" + encodeURIComponent(st)), env);
  assert.match(await ma.text(), /shop account/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shopee_shops").get().n, 0);
  assert.equal(calls.filter(c => c.kind === "shop_info").length, 0);
});

test("verify reads shop info; expired access token is refreshed and the rotated pair stored; refresh failure marks expired", async (t) => {
  const { db, env } = await setup();
  const calls = shopee(t);
  await connect(env);
  const id = db.prepare("SELECT id FROM shopee_shops").get().id;
  const ok = await worker.fetch(api("/shopee-seller/shops/" + id + "/verify", "POST", {}), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).shop_name, "mccyver");
  assert.equal(calls.at(-1).at, "sat.1");
  db.prepare("UPDATE shopee_shops SET token_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
  const before = db.prepare("SELECT encrypted_refresh_token r FROM shopee_shops WHERE id=?").get(id).r;
  assert.equal((await worker.fetch(api("/shopee-seller/shops/" + id + "/verify", "POST", {}), env)).status, 200);
  assert.deepEqual(calls.slice(-2).map(c => c.kind), ["refresh", "shop_info"]);
  assert.equal(calls.at(-2).body.refresh_token, "srt.1");
  assert.equal(calls.at(-1).at, "sat.2");
  assert.notEqual(db.prepare("SELECT encrypted_refresh_token r FROM shopee_shops WHERE id=?").get(id).r, before);
  db.prepare("UPDATE shopee_shops SET token_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "error_auth", message: "refresh token expired" });
  const fail = await worker.fetch(api("/shopee-seller/shops/" + id + "/verify", "POST", {}), env);
  globalThis.fetch = original;
  assert.equal(fail.status, 502);
  assert.equal(db.prepare("SELECT status FROM shopee_shops WHERE id=?").get(id).status, "expired");
});

test("disconnect wipes stored tokens; unknown shop ids return 404", async (t) => {
  const { db, env } = await setup();
  shopee(t);
  await connect(env);
  const id = db.prepare("SELECT id FROM shopee_shops").get().id;
  assert.equal((await worker.fetch(api("/shopee-seller/shops/" + id, "DELETE"), env)).status, 200);
  const row = db.prepare("SELECT status,encrypted_access_token a,encrypted_refresh_token r FROM shopee_shops WHERE id=?").get(id);
  assert.deepEqual({ ...row }, { status: "disconnected", a: null, r: null });
  assert.equal((await worker.fetch(api("/shopee-seller/shops/nope/verify", "POST", {}), env)).status, 404);
  assert.equal((await worker.fetch(api("/shopee-seller/shops/nope", "DELETE"), env)).status, 404);
});
