// TikTok "Upload to TikTok" inbox-draft tests: real SQLite, mocked TikTok API. Nothing is published.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { tiktokInboxProblems, tiktokDraftCaption, TIKTOK_DEFAULT_HASHTAGS } from "../cloudflare/worker.mjs";

const BASE = "https://social-api.siamhrbp.com/api/social-commerce";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(9);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const MP4 = (() => { const b = new Uint8Array(200 * 1024); b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0); return b; })();

function d1(db) {
  return { prepare(sql) { const st = db.prepare(sql); let args = []; const o = {
    bind(...a) { args = a.map(v => v === undefined ? null : v); return o; },
    async first() { return st.get(...args) ?? null; },
    async all() { return { results: st.all(...args) }; },
    async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
}
async function encryptToken(value) {
  const key = await crypto.subtle.importKey("raw", RAW_KEY, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(3);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("alpha-centauri-social-v1") }, key, new TextEncoder().encode(value));
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}
async function setup(t, { scopes = ["user.info.basic", "video.upload"], initError = null, putStatus = 201 } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql"]) db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','a@x.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,token_expires_at,encrypted_access_token,created_at,updated_at) VALUES('tt1','u1','tiktok','open-1','Kilo Mac','connected',?,'{}','2999-01-01T00:00:00Z',?,?,?)")
    .run(JSON.stringify(scopes), await encryptToken("ACT"), stamp, stamp);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/v2/post/publish/inbox/video/init/") {
      const body = JSON.parse(init.body); calls.push({ kind: "init", body, auth: init.headers.Authorization });
      return initError ? Response.json({ error: { code: "scope_not_authorized", message: initError } }, { status: 401 }) : Response.json({ data: { publish_id: "v_inbox_1", upload_url: "https://open-upload.tiktokapis.com/upload/?id=1" }, error: { code: "ok" } });
    }
    if (u.hostname === "open-upload.tiktokapis.com") { calls.push({ kind: "put", range: init.headers["Content-Range"], type: init.headers["Content-Type"], size: init.body.byteLength }); return new Response(null, { status: putStatus }); }
    if (u.pathname === "/v2/post/publish/status/fetch/") { calls.push({ kind: "status" }); return Response.json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } }); }
    if (/\/publish\/video\/init\//.test(u.pathname)) throw new Error("Direct Post must never be called");
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return { db, calls, env: { DB: d1(db), TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), TIKTOK_CLIENT_KEY: "ck", TIKTOK_CLIENT_SECRET: "cs" } };
}
const up = (env, key = "clip-2026-11-26", body = MP4) => worker.fetch(new Request(BASE + "/tiktok/inbox-upload", { method: "POST", headers: { Authorization: "Bearer session-token", "Content-Type": "video/mp4", ...(key ? { "Idempotency-Key": key } : {}) }, body }), env);

test("problems: needs a connected account, video.upload scope and a 50 KB–64 MB file", () => {
  assert.deepEqual(tiktokInboxProblems(null, 1), ["no connected TikTok account"]);
  assert.match(tiktokInboxProblems({ status: "connected", scopes_json: '["user.info.basic"]' }, 1e6).join(), /video\.upload/);
  assert.match(tiktokInboxProblems({ status: "connected", scopes_json: '["video.upload"]' }, 70 * 1024 * 1024).join(), /64 MB/);
});

test("uploads one MP4 as an inbox draft (single chunk) and reports the TikTok status", async (t) => {
  const { db, calls, env } = await setup(t);
  const r = await up(env);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.mode, "inbox_draft");
  assert.equal(b.status.status, "SEND_TO_USER_INBOX");
  assert.deepEqual(calls.map(c => c.kind), ["init", "put", "status"]);
  assert.deepEqual(calls[0].body, { source_info: { source: "FILE_UPLOAD", video_size: MP4.length, chunk_size: MP4.length, total_chunk_count: 1 } });
  assert.equal(calls[1].range, `bytes 0-${MP4.length - 1}/${MP4.length}`);
  assert.equal(calls[1].type, "video/mp4");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='tiktok_inbox_upload'").get().n, 1);
});

test("the same Idempotency-Key never sends a second draft", async (t) => {
  const { calls, env } = await setup(t);
  assert.equal((await up(env)).status, 200);
  const again = await up(env);
  assert.equal(again.status, 409);
  assert.equal(calls.filter(c => c.kind === "init").length, 1);
});

test("refuses without video.upload scope, without a key, or for a non-MP4 — before calling TikTok", async (t) => {
  const a = await setup(t, { scopes: ["user.info.basic"] });
  assert.equal((await up(a.env)).status, 422);
  assert.equal((await up(a.env, null)).status, 422);
  assert.equal((await up(a.env, "k-123", new Uint8Array(200 * 1024))).status, 422);
  assert.equal(a.calls.length, 0);
});

test("a TikTok init error is reported and audited; no upload happens", async (t) => {
  const { db, calls, env } = await setup(t, { initError: "scope not authorized" });
  const r = await up(env);
  assert.equal(r.status, 502);
  assert.deepEqual(calls.map(c => c.kind), ["init"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='tiktok_inbox_upload_failed'").get().n, 1);
});

test("caption: title + line + CTA + hashtags, cleaned, deduped, ≤2200 chars; no title → null", () => {
  const c = tiktokDraftCaption({ title: " คนเก่ง ≠ คนเหมาะ ", line: "เลือกคนที่ใช่\nกับทีม" });
  const lines = c.split("\n");
  assert.equal(lines[0], "คนเก่ง ≠ คนเหมาะ");
  assert.equal(lines[1], "เลือกคนที่ใช่ กับทีม");
  assert.match(lines[2], /สนใจ/);
  assert.equal(lines[3], TIKTOK_DEFAULT_HASHTAGS.join(" "));
  assert.equal(tiktokDraftCaption({ title: "A", hashtags: ["HR", "#HR", "two words"] }).split("\n").pop(), "#HR #twowords");
  assert.ok(tiktokDraftCaption({ title: "x".repeat(5000), line: "y".repeat(5000) }).length <= 2200);
  assert.equal(tiktokDraftCaption({ title: "  " }), null);
});

test("upload stores the caption but never sends it to TikTok (init body = source_info only)", async (t) => {
  const { calls, env } = await setup(t);
  const r = await worker.fetch(new Request(BASE + "/tiktok/inbox-upload?title=" + encodeURIComponent("หัวข้อทดสอบ") + "&line=" + encodeURIComponent("ประโยคเด็ด"), { method: "POST", headers: { Authorization: "Bearer session-token", "Idempotency-Key": "clip-cap" }, body: MP4 }), env);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.caption_prefilled, false);
  assert.match(b.caption, /^หัวข้อทดสอบ\nประโยคเด็ด\n/);
  assert.deepEqual(Object.keys(calls[0].body), ["source_info"]);
  assert.ok(!JSON.stringify(calls[0].body).includes("หัวข้อ"));
  const list = await (await worker.fetch(new Request(BASE + "/tiktok/drafts", { headers: { Authorization: "Bearer session-token" } }), env)).json();
  assert.equal(list.drafts[0].caption, b.caption);
});

test("draft-caption attaches a caption to an existing draft only (no TikTok call); drafts lists the newest caption", async (t) => {
  const { calls, env } = await setup(t);
  await up(env, "clip-old");
  const n = calls.length;
  const post = (body) => worker.fetch(new Request(BASE + "/tiktok/draft-caption", { method: "POST", headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  assert.equal((await post({ publish_id: "nope", title: "x" })).status, 404);
  assert.equal((await post({ publish_id: "v_inbox_1" })).status, 422);
  const ok = await post({ publish_id: "v_inbox_1", title: "แคปชันใหม่" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).sent_to_tiktok, false);
  assert.equal(calls.length, n, "no request to TikTok");
  const list = await (await worker.fetch(new Request(BASE + "/tiktok/drafts", { headers: { Authorization: "Bearer session-token" } }), env)).json();
  assert.equal(list.drafts.length, 1);
  assert.match(list.drafts[0].caption, /^แคปชันใหม่\n/);
});

test("endpoints require a Dashboard session", async (t) => {
  const { env } = await setup(t);
  assert.equal((await worker.fetch(new Request(BASE + "/tiktok/inbox-upload", { method: "POST", body: MP4 }), env)).status, 401);
});
