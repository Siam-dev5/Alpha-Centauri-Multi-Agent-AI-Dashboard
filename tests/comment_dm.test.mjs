// "เลขาส่วนตัว" Private Reply tests: real SQLite (schema + migrations), mocked Workers AI and Graph API.
// No request leaves the process; the fake Graph API records every comment read and message send.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { isKeywordComment, commentDmReadiness, runCommentSecretary } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
const POST = PAGE + "_901";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(5);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64");
const FULL_SCOPES = ["pages_manage_posts", "pages_read_user_content", "pages_messaging"];
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

function d1(db) {
  return { prepare(sql) { const st = db.prepare(sql); let args = []; const o = {
    bind(...a) { args = a.map(v => v === undefined ? null : v); return o; },
    async first() { return st.get(...args) ?? null; },
    async all() { return { results: st.all(...args) }; },
    async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
}
async function encryptToken(value) {
  const key = await crypto.subtle.importKey("raw", RAW_KEY, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(2);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("alpha-centauri-social-v1") }, key, new TextEncoder().encode(value));
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}
const ai = { async run(model, input) {
  if (model.includes("flux") || model.includes("lucid")) return { image: JPEG_B64 };
  if (input.messages[0].content.includes("Master Bot")) return { choices: [{ message: { content: JSON.stringify({ summary: "s", topic: "t", audience: "HR", tone: "เป็นกันเอง", creative_brief: "brief" }) } }] };
  return { choices: [{ message: { content: JSON.stringify({ concept: "c", caption: "แคปชันทดสอบสำหรับคนทำงาน HR สายสรรหา สนใจคอมเมนต์ สนใจ", cover_prompt: "a", illustration_prompt: "b", banner_prompt: "c" }) } }] };
} };

const COMMENTS = [
  { id: "c1", message: "สนใจครับ", from: { id: "u-owner", name: "Owner Test" }, created_time: ago(1) },
  { id: "c2", message: " สนใจ 🙏", from: { id: "u-2", name: "Public Person" }, created_time: ago(2) },
  { id: "c3", message: "ไม่สนใจ", from: { id: "u-3", name: "No" }, created_time: ago(1) },
  { id: "c4", message: "สนใจ", from: { id: PAGE, name: "The Page" }, created_time: ago(1) },
  { id: "c5", message: "สนใจค่ะ", from: { id: "u-owner", name: "Owner Test" }, created_time: ago(1) },
  { id: "c6", message: "สนใจ", from: { id: "u-6", name: "Old" }, created_time: ago(24 * 8) },
  { id: "c7", message: "ราคาเท่าไหร่ สนใจ", from: { id: "u-7", name: "Q" }, created_time: ago(1) }
];
function graph(t, { sendError = null } = {}) {
  const calls = { reads: 0, sends: [] };
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === `/v27.0/${PAGE}/photos`) return Response.json({ id: "ph" + (++n) });
    if (u.pathname === `/v27.0/${PAGE}/feed`) return Response.json({ id: POST });
    if (u.pathname === `/v27.0/${POST}` && !init.method) return Response.json({ permalink_url: "https://www.facebook.com/x/posts/901" });
    if (u.pathname === `/v27.0/${POST}/comments`) { calls.reads++; assert.ok(u.searchParams.get("appsecret_proof")); return Response.json({ data: COMMENTS }); }
    if (u.pathname === `/v27.0/${PAGE}/messages` && init.method === "POST") {
      const recipient = JSON.parse(init.body.get("recipient")), message = JSON.parse(init.body.get("message"));
      calls.sends.push({ comment_id: recipient.comment_id, text: message.text });
      return sendError ? Response.json({ error: { message: sendError } }, { status: 400 }) : Response.json({ recipient_id: "psid", message_id: "m_" + recipient.comment_id });
    }
    throw new Error("unexpected request " + init.method + " " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
async function setup(t, { scopes = FULL_SCOPES, env: extra = {}, migration = true, sendError = null } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql", "../migrations/0008_creative_workflow.sql"];
  if (migration) files.push("../migrations/0010_comment_leads.sql");
  for (const f of files) db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES('acc0','u1','facebook',?,?,'connected',?,'[\"CREATE_CONTENT\",\"MESSAGING\"]',?,?,?)")
    .run(PAGE, "ชุมชน HR สายงานสรรหาว่าจ้าง", JSON.stringify(scopes), await encryptToken("PAGE-TOKEN"), stamp, stamp);
  const calls = graph(t, { sendError });
  const env = { DB: d1(db), AI: ai, TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0", ...extra };
  // One real workflow run publishes POST (mocked Graph API), so the scan has a workflow post to read.
  const api = (path, method = "GET", body) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, { method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const v = await (await worker.fetch(api("/workflows", "POST", { command: "[CID:T-1] ให้ทีม Creative ทำคอนเทนต์และกราฟิกแล้วโพสต์ลงเพจ" }), env)).json();
  for (let i = 0; i < 8; i++) await worker.fetch(api(`/workflows/${v.run.id}/advance`, "POST"), env);
  assert.equal(db.prepare("SELECT status FROM workflow_runs").get().status, "completed");
  return { db, env, calls, api };
}
const LIVE = { COMMENT_DM_MODE: "live", COMMENT_DM_TEXT: "ขอบคุณที่สนใจครับ ทีมงานจะส่งรายละเอียดให้ทางนี้", COMMENT_DM_ALLOW_IDS: "u-owner" };

test("keyword matching: exact word, spaces/emoji/punctuation, polite particles only", () => {
  for (const ok of ["สนใจ", " สนใจ ", "สนใจครับ", "สนใจค่ะ", "สนใจคะ", "สนใจ!!", "สนใจ 🙏", "สนใจนะครับ"]) assert.equal(isKeywordComment(ok), true, ok);
  for (const no of ["ไม่สนใจ", "สนใจไหม", "ราคาเท่าไหร่ สนใจ", "สน ใจ x", "", null]) assert.equal(isKeywordComment(no), false, String(no));
});

test("readiness needs pages_messaging, MESSAGING task and an approved message", () => {
  assert.deepEqual(commentDmReadiness({}, ["pages_read_user_content"], ["CREATE_CONTENT"]).missing, ["pages_messaging", "Page task MESSAGING", "COMMENT_DM_TEXT (approved message)"]);
  assert.equal(commentDmReadiness({ COMMENT_DM_TEXT: "x" }, FULL_SCOPES, ["MESSAGING"]).ready, true);
});

test("mode off (default): no comment is read and nothing is sent", async (t) => {
  const { env, calls } = await setup(t);
  assert.deepEqual(await runCommentSecretary(env), []);
  assert.equal(calls.reads, 0);
  assert.equal(calls.sends.length, 0);
});

test("dry_run records only real keyword comments and sends nothing", async (t) => {
  const { db, env, calls } = await setup(t, { env: { COMMENT_DM_MODE: "dry_run" } });
  const [r] = await runCommentSecretary(env);
  assert.equal(r.new_leads, 4, "c1, c2, c5, c6 (page's own c4, 'ไม่สนใจ' and questions excluded)");
  assert.equal(calls.sends.length, 0);
  assert.deepEqual(db.prepare("SELECT comment_id FROM comment_leads ORDER BY comment_id").all().map(x => x.comment_id), ["c1", "c2", "c5", "c6"]);
  assert.equal((await runCommentSecretary(env))[0].new_leads, 0, "re-scan adds no duplicates");
});

test("live without pages_messaging does not send", async (t) => {
  const { env, calls } = await setup(t, { scopes: ["pages_manage_posts", "pages_read_user_content"], env: LIVE });
  const [r] = await runCommentSecretary(env);
  assert.match(r.error, /pages_messaging/);
  assert.equal(calls.sends.length, 0);
});

test("live test mode: only the allow-listed commenter gets ONE private reply, never repeated", async (t) => {
  const { db, env, calls } = await setup(t, { env: LIVE });
  const [r] = await runCommentSecretary(env);
  assert.deepEqual(calls.sends, [{ comment_id: "c1", text: LIVE.COMMENT_DM_TEXT }], "one message, to the owner's first comment");
  assert.equal(r.sent, 1);
  const rows = Object.fromEntries(db.prepare("SELECT comment_id,status,reason FROM comment_leads").all().map(x => [x.comment_id, x]));
  assert.equal(rows.c1.status, "sent");
  assert.equal(rows.c2.status, "skipped"); assert.match(rows.c2.reason, /ALLOW_IDS/);
  assert.equal(rows.c5.status, "skipped"); assert.match(rows.c5.reason, /already messaged/);
  assert.equal(rows.c6.status, "skipped"); assert.match(rows.c6.reason, /7-day/);
  await runCommentSecretary(env);
  assert.equal(calls.sends.length, 1, "a second run sends nothing more");
});

test("a Facebook send error marks the lead failed and is not retried", async (t) => {
  const { db, env, calls } = await setup(t, { env: LIVE, sendError: "(#10) This message is sent outside of allowed window." });
  await runCommentSecretary(env);
  await runCommentSecretary(env);
  assert.equal(calls.sends.length, 1);
  assert.equal(db.prepare("SELECT status FROM comment_leads WHERE comment_id='c1'").get().status, "failed");
});

test("API: view and manual scan require a session; missing migration is reported, not crashed", async (t) => {
  const { env, api } = await setup(t, { env: { COMMENT_DM_MODE: "dry_run" }, migration: false });
  assert.equal((await worker.fetch(new Request("https://social-api.siamhrbp.com/api/social-commerce/secretary"), env)).status, 401);
  const view = await (await worker.fetch(api("/secretary"), env)).json();
  assert.equal(view.schema_ready, false);
  assert.equal(view.mode, "dry_run");
  const scan = await (await worker.fetch(api("/secretary/scan", "POST", {}), env)).json();
  assert.match(scan.results[0].error, /0010_comment_leads/);
});
