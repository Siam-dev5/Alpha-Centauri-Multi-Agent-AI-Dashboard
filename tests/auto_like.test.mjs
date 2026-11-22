// "แอดมินโซเชียล" auto-like tests against a real SQLite database built from the repo schema and migrations.
// The Graph API is mocked: no request leaves the test process.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { filterOwnPagePosts, autoLikeReadiness } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
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

async function encryptToken(value) {
  const key = await crypto.subtle.importKey("raw", RAW_KEY, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(3);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("alpha-centauri-social-v1") }, key, new TextEncoder().encode(value));
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}

async function setup({ scopes = ["pages_manage_engagement", "pages_read_engagement", "pages_manage_posts"] } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql"]) {
    db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  }
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES('acc1','u1','facebook',?,'Test Page','connected',?,?,?,?,?)")
    .run(PAGE, JSON.stringify(scopes), JSON.stringify(["CREATE_CONTENT", "MANAGE"]), await encryptToken("PAGE-TOKEN"), stamp, stamp);
  return { db, env: { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0" } };
}

// Fake Graph API: a mutable list of Page posts plus a record of like calls.
function graph(t, posts, { likeError = null } = {}) {
  const likes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === `/v27.0/${PAGE}/posts`) {
      assert.equal(u.searchParams.get("access_token"), "PAGE-TOKEN");
      assert.ok(u.searchParams.get("appsecret_proof"));
      return Response.json({ data: posts });
    }
    const m = u.pathname.match(/^\/v27\.0\/([^/]+)\/likes$/);
    if (m && init.method === "POST") {
      likes.push(decodeURIComponent(m[1]));
      assert.equal(init.body.get("access_token"), "PAGE-TOKEN");
      return likeError ? Response.json({ error: { message: likeError } }, { status: 400 }) : Response.json({ success: true });
    }
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return likes;
}

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const api = (path, method = "GET", body) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
});
const cron = (env) => new Promise((resolve, reject) => worker.scheduled({}, env, { waitUntil: (p) => p.then(resolve, reject) }));
const ledger = (db) => db.prepare("SELECT post_id,source,status FROM page_post_likes ORDER BY post_id").all().map(r => ({ ...r }));

test("only posts authored by the connected Page are eligible", () => {
  const posts = [
    { id: PAGE + "_1", from: { id: PAGE } },
    { id: PAGE + "_2" },
    { id: "999_3", from: { id: "999" } },
    { id: PAGE + "_4", from: { id: "visitor" } },
    { id: 5 }
  ];
  assert.deepEqual(filterOwnPagePosts(PAGE, posts).map(p => p.id), [PAGE + "_1", PAGE + "_2"]);
});

test("readiness requires pages_manage_engagement and a content task", () => {
  assert.equal(autoLikeReadiness(["pages_manage_engagement", "pages_read_engagement"], ["CREATE_CONTENT"]).ready, true);
  assert.deepEqual(autoLikeReadiness(["pages_read_engagement"], ["CREATE_CONTENT"]).missing, ["pages_manage_engagement"]);
});

test("enabling likes the 2 latest own posts once, then cron likes only new posts once", async (t) => {
  const { db, env } = await setup();
  const posts = [
    { id: PAGE + "_old", created_time: iso(300), from: { id: PAGE } },
    { id: PAGE + "_b", created_time: iso(60), from: { id: PAGE } },
    { id: PAGE + "_a", created_time: iso(30), from: { id: PAGE } },
    { id: "777_foreign", created_time: iso(5), from: { id: "777" } }
  ];
  const likes = graph(t, posts);

  const res = await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true, backfill_count: 2 }), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.enabled, true);
  assert.deepEqual(out.backfill_queued.sort(), [PAGE + "_a", PAGE + "_b"]);
  assert.equal(out.run.liked, 2);
  assert.deepEqual(likes.sort(), [PAGE + "_a", PAGE + "_b"]);

  // Cron with no new posts: no further likes.
  await cron(env);
  await cron(env);
  assert.equal(likes.length, 2);

  // A new Page post appears after enabling: liked exactly once across repeated runs.
  posts.unshift({ id: PAGE + "_new", created_time: new Date(Date.now() + 1000).toISOString(), from: { id: PAGE } });
  await cron(env);
  await cron(env);
  const manual = await (await worker.fetch(api("/automation/auto-like/run", "POST"), env)).json();
  assert.equal(manual.runs[0].liked, 0);
  assert.deepEqual(likes.sort(), [PAGE + "_a", PAGE + "_b", PAGE + "_new"]);
  assert.ok(!likes.includes("777_foreign"));
  assert.ok(!likes.includes(PAGE + "_old"));
  assert.deepEqual(ledger(db), [
    { post_id: PAGE + "_a", source: "backfill", status: "liked" },
    { post_id: PAGE + "_b", source: "backfill", status: "liked" },
    { post_id: PAGE + "_new", source: "auto", status: "liked" }
  ]);
  const events = db.prepare("SELECT event_type, COUNT(*) n FROM audit_events GROUP BY event_type ORDER BY event_type").all().map(r => ({ ...r }));
  assert.deepEqual(events, [{ event_type: "auto_like_enabled", n: 1 }, { event_type: "page_post_liked", n: 3 }]);

  const status = await (await worker.fetch(api("/automation/auto-like"), env)).json();
  assert.equal(status.accounts[0].enabled, true);
  assert.equal(status.likes.length, 3);
  assert.ok(status.accounts[0].last_run_at);
});

test("re-enabling does not like the same posts again", async (t) => {
  const { env } = await setup();
  const posts = [{ id: PAGE + "_a", created_time: iso(30), from: { id: PAGE } }, { id: PAGE + "_b", created_time: iso(60), from: { id: PAGE } }];
  const likes = graph(t, posts);
  await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true, backfill_count: 2 }), env);
  await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: false }), env);
  await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true, backfill_count: 2 }), env);
  assert.equal(likes.length, 2);
});

test("disabled automation does nothing on cron", async (t) => {
  const { env } = await setup();
  const posts = [{ id: PAGE + "_a", created_time: iso(30), from: { id: PAGE } }];
  const likes = graph(t, posts);
  await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true, backfill_count: 0 }), env);
  await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: false }), env);
  posts.unshift({ id: PAGE + "_new", created_time: new Date(Date.now() + 1000).toISOString(), from: { id: PAGE } });
  await cron(env);
  assert.equal(likes.length, 0);
});

test("a Facebook error is logged as failed and not retried", async (t) => {
  const { db, env } = await setup();
  const likes = graph(t, [{ id: PAGE + "_a", created_time: iso(30), from: { id: PAGE } }], { likeError: "(#200) Permissions error" });
  const out = await (await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true, backfill_count: 1 }), env)).json();
  assert.equal(out.run.failed, 1);
  await cron(env);
  assert.equal(likes.length, 1);
  const row = db.prepare("SELECT status,error_message FROM page_post_likes").get();
  assert.equal(row.status, "failed");
  assert.match(row.error_message, /Permissions error/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='page_post_like_failed'").get().n, 1);
});

test("a Page without pages_manage_engagement cannot be enabled", async (t) => {
  const { env } = await setup({ scopes: ["pages_read_engagement"] });
  const likes = graph(t, []);
  const res = await worker.fetch(api("/automation/auto-like", "POST", { account_id: "acc1", enabled: true }), env);
  assert.equal(res.status, 403);
  assert.equal(likes.length, 0);
});

test("automation routes require a session", async () => {
  const { env } = await setup();
  for (const [path, method] of [["/automation/auto-like", "GET"], ["/automation/auto-like", "POST"], ["/automation/auto-like/run", "POST"]]) {
    const res = await worker.fetch(new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, { method }), env);
    assert.equal(res.status, 401, path);
  }
});
