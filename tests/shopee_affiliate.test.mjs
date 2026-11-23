// Shopee Affiliate Open API (connection check only) tests against a real SQLite database built from the repo schema.
// Shopee's API is mocked: no request leaves the test process, and only the read-only offer query is allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { shopeeAffiliateAuthorization, shopeeAffiliateConfigured, shopeeAffiliateEndpoint, SHOPEE_AFFILIATE_VERIFY_QUERY } from "../cloudflare/worker.mjs";

const BASE = "https://social-api.siamhrbp.com/api/social-commerce";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const hex = async (v) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))).toString("hex");

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

async function setup(extraEnv = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql"]) {
    db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  }
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  const env = { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(new Uint8Array(32).fill(9)), SHOPEE_AFFILIATE_APP_ID: "15301234567", SHOPEE_AFFILIATE_SECRET: "shp_secret_test", ...extraEnv };
  return { db, env };
}

const api = (path, method = "GET", body) => new Request(BASE + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined
});

// Fake Shopee Affiliate GraphQL endpoint: checks the signature and refuses anything except the read-only offer query.
function shopee(t, { error = null, httpStatus = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.origin + u.pathname, "https://open-api.affiliate.shopee.co.th/graphql", "only Shopee's Affiliate GraphQL endpoint may be called");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    const body = String(init.body);
    const parsed = JSON.parse(body);
    assert.equal(parsed.query, SHOPEE_AFFILIATE_VERIFY_QUERY, "only the read-only offer query is sent");
    assert.doesNotMatch(body, /mutation|generateShortLink|conversionReport/i);
    const m = /^SHA256 Credential=(\d+), Timestamp=(\d+), Signature=([0-9a-f]{64})$/.exec(init.headers.Authorization);
    assert.ok(m, "Authorization header follows Shopee's format");
    assert.ok(Math.abs(Number(m[2]) - Date.now() / 1000) < 600, "timestamp within Shopee's 10-minute window");
    assert.equal(m[3], await hex(m[1] + m[2] + body + "shp_secret_test"), "signature = SHA256(AppId+Timestamp+Payload+Secret)");
    assert.doesNotMatch(init.headers.Authorization + body, /shp_secret_test/, "the secret itself is never sent");
    calls.push({ appId: m[1] });
    if (error) return Response.json({ errors: [{ message: "error", extensions: error }] }, { status: 200 });
    if (httpStatus !== 200) return new Response("bad gateway", { status: httpStatus });
    return Response.json({ data: { shopeeOfferV2: { nodes: [{ offerName: "Sample offer" }], pageInfo: { page: 1, limit: 1, hasNextPage: true } } } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("signature matches Shopee's published example (AppId 123456, Secret demo)", async () => {
  const payload = JSON.stringify({ query: "{\nbrandOffer{\n    nodes{\n        commissionRate\n        offerName\n    }\n}\n}" });
  const header = await shopeeAffiliateAuthorization("123456", "demo", 1577836800, payload);
  assert.equal(header, "SHA256 Credential=123456, Timestamp=1577836800, Signature=dc88d72feea70c80c52c3399751a7d34966763f51a7f056aa070a5e9df645412");
});

test("config helpers: both secrets required; endpoint override limited to Shopee affiliate hosts", () => {
  assert.equal(shopeeAffiliateConfigured({ SHOPEE_AFFILIATE_APP_ID: "1" }), false);
  assert.equal(shopeeAffiliateConfigured({ SHOPEE_AFFILIATE_APP_ID: "1", SHOPEE_AFFILIATE_SECRET: "s" }), true);
  assert.equal(shopeeAffiliateEndpoint({}), "https://open-api.affiliate.shopee.co.th/graphql");
  assert.equal(shopeeAffiliateEndpoint({ SHOPEE_AFFILIATE_ENDPOINT: "https://evil.example/graphql" }), "https://open-api.affiliate.shopee.co.th/graphql");
  assert.equal(shopeeAffiliateEndpoint({ SHOPEE_AFFILIATE_ENDPOINT: "https://open-api.affiliate.shopee.com.my/graphql" }), "https://open-api.affiliate.shopee.com.my/graphql");
});

test("health reports awaiting approval until AppID/Secret exist; connect returns 503 and calls nothing", async (t) => {
  const { env, db } = await setup({ SHOPEE_AFFILIATE_APP_ID: "", SHOPEE_AFFILIATE_SECRET: "" });
  const calls = shopee(t);
  const health = await (await worker.fetch(new Request(BASE + "/health"), env)).json();
  assert.equal(health.platforms.shopee_affiliate, "awaiting_api_approval");
  assert.equal(health.shopee_affiliate_configured, false);
  assert.equal(health.shopee_affiliate_mode, "read_only");
  assert.equal(health.platforms.lazada_affiliate, "oauth_not_configured");
  const r = await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env);
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0);
  const ready = await setup();
  assert.equal((await (await worker.fetch(new Request(BASE + "/health"), ready.env)).json()).platforms.shopee_affiliate, "api_ready");
});

test("connect requires a Dashboard session", async (t) => {
  const { env } = await setup();
  const calls = shopee(t);
  const r = await worker.fetch(new Request(BASE + "/affiliate/shopee/connect", { method: "POST" }), env);
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test("connect: signed read-only check, account saved once (reconnect does not duplicate), secret never stored", async (t) => {
  const { env, db } = await setup();
  const calls = shopee(t);
  const r = await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.connected, true);
  assert.equal(body.account_name, "Shopee Affiliate TH · AppID ••••4567");
  assert.equal(calls.length, 1);
  assert.equal((await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env)).status, 200);
  const rows = db.prepare("SELECT * FROM social_accounts WHERE platform='shopee_affiliate'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "connected");
  assert.equal(rows[0].external_account_id, "15301234567");
  assert.equal(rows[0].encrypted_access_token, null);
  assert.doesNotMatch(JSON.stringify(rows) + JSON.stringify(db.prepare("SELECT * FROM audit_events").all()), /shp_secret_test/);
  const list = await (await worker.fetch(api("/accounts"), env)).json();
  const acct = list.accounts.find(a => a.platform === "shopee_affiliate");
  assert.equal(acct.publish_ready, false);
  assert.ok(acct.connection.verified_at);
});

test("connect failure (bad signature 10020) saves nothing and explains the cause", async (t) => {
  const { env, db } = await setup();
  shopee(t, { error: { code: 10020, message: "Invalid Signature" } });
  const r = await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env);
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.match(body.error, /10020/);
  assert.match(body.error, /AppID\/Secret/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='shopee_affiliate_connect_failed'").get().n, 1);
});

test("verify: live check updates verified_at; transient error keeps connected; credential error marks error", async (t) => {
  const { env, db } = await setup();
  shopee(t);
  const { id } = await (await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env)).json();
  const ok = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).platform, "shopee_affiliate");

  globalThis.fetch = async () => Response.json({ errors: [{ message: "limit", extensions: { code: 10030, message: "Rate limit" } }] });
  const busy = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(busy.status, 502);
  assert.equal(db.prepare("SELECT status FROM social_accounts WHERE id=?").get(id).status, "connected");

  globalThis.fetch = async () => Response.json({ errors: [{ message: "auth", extensions: { code: 10020, message: "Invalid Signature" } }] });
  const bad = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(bad.status, 502);
  assert.equal(db.prepare("SELECT status FROM social_accounts WHERE id=?").get(id).status, "error");
});

test("verify detects a changed AppID on the Worker", async (t) => {
  const { env, db } = await setup();
  shopee(t);
  const { id } = await (await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env)).json();
  env.SHOPEE_AFFILIATE_APP_ID = "15309999999";
  globalThis.fetch = async () => Response.json({ data: { shopeeOfferV2: { nodes: [], pageInfo: { page: 1, limit: 1, hasNextPage: false } } } });
  const r = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /AppID changed/);
  assert.equal(db.prepare("SELECT status FROM social_accounts WHERE id=?").get(id).status, "error");
});

test("disconnect clears the Shopee account; manual affiliate account creation stays disabled", async (t) => {
  const { env, db } = await setup();
  shopee(t);
  const { id } = await (await worker.fetch(api("/affiliate/shopee/connect", "POST", {}), env)).json();
  const del = await worker.fetch(api("/accounts/" + id, "DELETE"), env);
  assert.equal(del.status, 200);
  assert.equal(db.prepare("SELECT status FROM social_accounts WHERE id=?").get(id).status, "disconnected");
  const manual = await worker.fetch(api("/accounts", "POST", { platform: "shopee_affiliate", external_account_id: "x", account_name: "x" }), env);
  assert.equal(manual.status, 409);
});
