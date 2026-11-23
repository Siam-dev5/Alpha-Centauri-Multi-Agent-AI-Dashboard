// TikTok Login Kit (connect only) tests against a real SQLite database built from the repo schema and migrations.
// TikTok's API is mocked: no request leaves the test process, and no content is ever posted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { buildTikTokAuthorizationUrl, tiktokScopes, tiktokConfigured } from "../cloudflare/worker.mjs";

const BASE = "https://social-api.siamhrbp.com/api/social-commerce";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(9);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

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
  const env = { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), TIKTOK_CLIENT_KEY: "ck_test", TIKTOK_CLIENT_SECRET: "cs_test", ...extraEnv };
  return { db, env };
}

const api = (path, method = "GET", body) => new Request(BASE + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined
});

// Fake TikTok API. Records every call; refuses anything that is not token, user info or revoke (no posting endpoints).
function tiktok(t, { tokenError = null, refreshError = null, openId = "open-123" } = {}) {
  const calls = [];
  let issued = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.hostname, "open.tiktokapis.com", "only TikTok's API may be called");
    if (u.pathname === "/v2/oauth/token/") {
      const form = new URLSearchParams(String(init.body));
      calls.push({ kind: "token", grant: form.get("grant_type"), form: Object.fromEntries(form) });
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(form.get("client_key"), "ck_test");
      assert.equal(form.get("client_secret"), "cs_test");
      if (form.get("grant_type") === "authorization_code" && tokenError) return Response.json({ error: "invalid_request", error_description: tokenError, log_id: "x" }, { status: 400 });
      if (form.get("grant_type") === "refresh_token" && refreshError) return Response.json({ error: "invalid_grant", error_description: refreshError, log_id: "x" }, { status: 400 });
      issued++;
      return Response.json({ access_token: "act." + issued, expires_in: 7200, refresh_token: "rft." + issued, refresh_expires_in: 15552000, open_id: openId, scope: "user.info.basic", token_type: "Bearer" });
    }
    if (u.pathname === "/v2/user/info/") {
      calls.push({ kind: "user", auth: init.headers.Authorization, fields: u.searchParams.get("fields") });
      return Response.json({ data: { user: { open_id: "open-123", union_id: "union-9", avatar_url: "https://p16.example/avatar.jpg", display_name: "HR Recruit TH" } }, error: { code: "ok", message: "", log_id: "y" } });
    }
    if (u.pathname === "/v2/oauth/revoke/") {
      calls.push({ kind: "revoke", token: new URLSearchParams(String(init.body)).get("token") });
      return Response.json({});
    }
    throw new Error("unexpected TikTok request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function startAndCallback(env, extraQuery = "") {
  const start = await worker.fetch(api("/oauth/tiktok/start", "POST", {}), env);
  assert.equal(start.status, 200);
  const data = await start.json();
  const state = new URL(data.authorization_url).searchParams.get("state");
  const cb = await worker.fetch(new Request(BASE + "/oauth/tiktok/callback?code=" + encodeURIComponent("code*abc!") + "&scopes=user.info.basic&state=" + encodeURIComponent(state) + extraQuery), env);
  return { start: data, state, callback: cb, html: await cb.text() };
}

test("authorization URL follows Login Kit for Web (client_key, comma scopes, code, registered redirect, state)", () => {
  const env = { TIKTOK_CLIENT_KEY: "ck_test", TIKTOK_CLIENT_SECRET: "cs_test", TIKTOK_SCOPES: "user.info.basic, user.info.profile" };
  const u = new URL(buildTikTokAuthorizationUrl(env, "STATE1"));
  assert.equal(u.origin + u.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(u.searchParams.get("client_key"), "ck_test");
  assert.equal(u.searchParams.get("scope"), "user.info.basic,user.info.profile");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://social-api.siamhrbp.com/api/social-commerce/oauth/tiktok/callback");
  assert.equal(u.searchParams.get("state"), "STATE1");
  assert.equal(u.searchParams.get("client_secret"), null, "the secret never goes to the browser");
  assert.deepEqual(tiktokScopes({}), ["user.info.basic"]);
  assert.equal(tiktokConfigured({ TIKTOK_CLIENT_KEY: "x" }), false);
});

test("health and start report not-configured until the client key and secret exist", async () => {
  const { env } = await setup({ TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "" });
  const health = await (await worker.fetch(new Request(BASE + "/health"), env)).json();
  assert.equal(health.platforms.tiktok, "oauth_not_configured");
  assert.equal(health.tiktok_oauth_configured, false);
  assert.equal(health.tiktok_publishing_enabled, false);
  const start = await worker.fetch(api("/oauth/tiktok/start", "POST", {}), env);
  assert.equal(start.status, 503);
  const ready = await setup();
  assert.equal((await (await worker.fetch(new Request(BASE + "/health"), ready.env)).json()).platforms.tiktok, "oauth_ready");
});

test("start requires a Dashboard session", async () => {
  const { env } = await setup();
  const r = await worker.fetch(new Request(BASE + "/oauth/tiktok/start", { method: "POST" }), env);
  assert.equal(r.status, 401);
});

test("full connect: state checked once, code exchanged, profile read, tokens stored encrypted", async (t) => {
  const { db, env } = await setup();
  const calls = tiktok(t);
  const { state, callback, html } = await startAndCallback(env);
  assert.equal(callback.status, 200);
  assert.match(html, /ALPHA_CENTAURI_TIKTOK_OAUTH/);
  assert.match(html, /"status":"connected"/);
  const exchange = calls.find(c => c.kind === "token");
  assert.equal(exchange.grant, "authorization_code");
  assert.equal(exchange.form.code, "code*abc!", "the URL-decoded code is sent");
  assert.equal(exchange.form.redirect_uri, "https://social-api.siamhrbp.com/api/social-commerce/oauth/tiktok/callback");
  assert.equal(calls.find(c => c.kind === "user").auth, "Bearer act.1");
  const row = db.prepare("SELECT * FROM social_accounts WHERE platform='tiktok'").get();
  assert.equal(row.external_account_id, "open-123");
  assert.equal(row.account_name, "HR Recruit TH");
  assert.equal(row.status, "connected");
  assert.deepEqual(JSON.parse(row.scopes_json), ["user.info.basic"]);
  assert.ok(row.encrypted_access_token && !row.encrypted_access_token.includes("act."), "token encrypted at rest");
  assert.ok(row.encrypted_refresh_token && !row.encrypted_refresh_token.includes("rft."));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM oauth_states").get().n, 0, "state is single use");
  // Replaying the same callback fails (state consumed) and does not duplicate the account.
  const replay = await worker.fetch(new Request(BASE + "/oauth/tiktok/callback?code=again&state=" + encodeURIComponent(state)), env);
  assert.match(await replay.text(), /"status":"error"/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE platform='tiktok'").get().n, 1);
  const events = db.prepare("SELECT event_type FROM audit_events ORDER BY created_at").all().map(e => e.event_type);
  assert.ok(events.includes("tiktok_account_connected") && events.includes("tiktok_oauth_completed"));
  // Account list exposes connection status, never tokens, and marks publishing as not enabled.
  const list = await (await worker.fetch(api("/accounts"), env)).json();
  const acct = list.accounts.find(a => a.platform === "tiktok");
  assert.equal(acct.publish_ready, false);
  assert.ok(acct.connection.verified_at);
  assert.equal(acct.encrypted_access_token, undefined);
  assert.equal(JSON.stringify(list).includes("act.1"), false);
});

test("reconnecting the same TikTok account updates it instead of adding a duplicate", async (t) => {
  const { db, env } = await setup();
  tiktok(t);
  await startAndCallback(env);
  await startAndCallback(env);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE platform='tiktok'").get().n, 1);
});

test("forged, expired or denied callbacks never reach TikTok's token endpoint", async (t) => {
  const { db, env } = await setup();
  const calls = tiktok(t);
  const forged = await worker.fetch(new Request(BASE + "/oauth/tiktok/callback?code=c&state=forged"), env);
  assert.match(await forged.text(), /OAuth state is invalid or expired/);
  const start = await (await worker.fetch(api("/oauth/tiktok/start", "POST", {}), env)).json();
  const state = new URL(start.authorization_url).searchParams.get("state");
  const denied = await worker.fetch(new Request(BASE + "/oauth/tiktok/callback?error=access_denied&state=" + encodeURIComponent(state)), env);
  assert.match(await denied.text(), /cancelled or denied/);
  const start2 = await (await worker.fetch(api("/oauth/tiktok/start", "POST", {}), env)).json();
  const state2 = new URL(start2.authorization_url).searchParams.get("state");
  db.prepare("UPDATE oauth_states SET expires_at='2000-01-01T00:00:00Z'").run();
  const expired = await worker.fetch(new Request(BASE + "/oauth/tiktok/callback?code=c&state=" + encodeURIComponent(state2)), env);
  assert.match(await expired.text(), /invalid or expired/);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0);
});

test("a TikTok token error is reported and audited without saving an account", async (t) => {
  const { db, env } = await setup();
  tiktok(t, { tokenError: "Redirect_uri is not matched" });
  const { html } = await startAndCallback(env);
  assert.match(html, /failed during token_exchange/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM social_accounts").get().n, 0);
  const failure = db.prepare("SELECT details_json FROM audit_events WHERE event_type='tiktok_oauth_failed'").get();
  assert.match(failure.details_json, /Redirect_uri is not matched/);
});

test("verify refreshes an expired access token (rotating the refresh token) and confirms the live account", async (t) => {
  const { db, env } = await setup();
  const calls = tiktok(t);
  await startAndCallback(env);
  const id = db.prepare("SELECT id FROM social_accounts WHERE platform='tiktok'").get().id;
  const oldRefresh = db.prepare("SELECT encrypted_refresh_token r FROM social_accounts").get().r;
  db.prepare("UPDATE social_accounts SET token_expires_at='2000-01-01T00:00:00Z'").run();
  const r = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.connected, true);
  assert.equal(body.open_id, "open-123");
  const refresh = calls.filter(c => c.kind === "token" && c.grant === "refresh_token");
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].form.refresh_token, "rft.1");
  assert.equal(calls.filter(c => c.kind === "user").at(-1).auth, "Bearer act.2");
  const row = db.prepare("SELECT token_expires_at,encrypted_refresh_token FROM social_accounts").get();
  assert.ok(Date.parse(row.token_expires_at) > Date.now());
  assert.notEqual(row.encrypted_refresh_token, oldRefresh);
  // A still-valid token is used as-is: no extra refresh.
  await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(calls.filter(c => c.kind === "token" && c.grant === "refresh_token").length, 1);
});

test("a failed refresh marks the account expired so the Dashboard asks to reconnect", async (t) => {
  const { db, env } = await setup();
  tiktok(t, { refreshError: "refresh token expired" });
  await startAndCallback(env);
  const id = db.prepare("SELECT id FROM social_accounts").get().id;
  db.prepare("UPDATE social_accounts SET token_expires_at='2000-01-01T00:00:00Z'").run();
  const r = await worker.fetch(api("/accounts/" + id + "/verify", "POST", {}), env);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).connected, false);
  assert.equal(db.prepare("SELECT status FROM social_accounts").get().status, "expired");
});

test("disconnect revokes the TikTok token and clears stored tokens", async (t) => {
  const { db, env } = await setup();
  const calls = tiktok(t);
  await startAndCallback(env);
  const id = db.prepare("SELECT id FROM social_accounts").get().id;
  const r = await worker.fetch(api("/accounts/" + id, "DELETE"), env);
  assert.equal(r.status, 200);
  assert.deepEqual(calls.filter(c => c.kind === "revoke").map(c => c.token), ["act.1"]);
  const row = db.prepare("SELECT status,encrypted_access_token,encrypted_refresh_token FROM social_accounts").get();
  assert.deepEqual({ ...row }, { status: "disconnected", encrypted_access_token: null, encrypted_refresh_token: null });
});

test("Facebook account listing is unchanged by the TikTok metadata column reuse", async () => {
  const { db, env } = await setup();
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,created_at,updated_at) VALUES('fb1','u1','facebook','1333','Page','connected',?,?,?,?)")
    .run(JSON.stringify(["pages_manage_posts"]), JSON.stringify(["CREATE_CONTENT"]), stamp, stamp);
  const list = await (await worker.fetch(api("/accounts"), env)).json();
  const fb = list.accounts.find(a => a.id === "fb1");
  assert.deepEqual(fb.page_tasks, ["CREATE_CONTENT"]);
  assert.equal(fb.publish_ready, true);
  assert.equal(fb.connection, null);
});
