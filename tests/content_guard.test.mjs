// Routine content bank + workflow content guard ([CID:...] duplicate block, CTA "..." enforcement).
// Real SQLite (schema + migrations), mocked Workers AI and Graph API: nothing is posted anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { wfDirectives, wfEnsureCta } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
const BANK = JSON.parse(readFileSync(new URL("../content/routine-content-bank.json", import.meta.url), "utf8"));
const ALL = [...BANK.week1, ...BANK.reserves];
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(5);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64");

// The Dashboard chat's real routing rule, taken from index.html so the test follows the shipped code.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = html.match(/function isCreativeWorkflowIntent\(text\) \{[\s\S]*?\n {8}\}/)[0];
const isCreativeWorkflowIntent = new Function(src + "\nreturn isCreativeWorkflowIntent;")();

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
// The fake Creative Bot "forgets" the CTA unless told otherwise, so the guard has to add it.
function fakeAI({ captionHasCta = false } = {}) {
  const calls = [];
  return { calls, async run(model, input) {
    calls.push(model);
    if (model.includes("flux") || model.includes("lucid")) return { image: JPEG_B64 };
    const sys = input.messages[0].content;
    if (sys.includes("Master Bot")) return { choices: [{ message: { content: JSON.stringify({ summary: "แผน", topic: "หัวข้อ", audience: "HR", tone: "เป็นกันเอง", creative_brief: "ทำคอนเทนต์ตามหัวข้อ" }) } }] };
    const caption = "เคล็ดลับสำหรับคนทำงาน HR สายสรรหา 3 ข้อที่ใช้ได้ทันที" + (captionHasCta ? "\nสนใจคอมเมนต์ว่า สนใจ" : "");
    return { choices: [{ message: { content: JSON.stringify({ concept: "คอนเซปต์", script: ["a", "b"], caption, cover_prompt: "office", illustration_prompt: "team", banner_prompt: "banner" }) } }] };
  } };
}
async function setup(ai = fakeAI()) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql", "../migrations/0008_creative_workflow.sql"]) {
    db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  }
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES('acc0','u1','facebook',?,?,'connected','[\"pages_manage_posts\"]','[\"CREATE_CONTENT\"]',?,?,?)")
    .run(PAGE, "ชุมชน HR สายงานสรรหาว่าจ้าง", await encryptToken("PAGE-TOKEN"), stamp, stamp);
  return { db, ai, env: { DB: d1(db), AI: ai, TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0" } };
}
function graph(t) {
  const posts = [];
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === `/v27.0/${PAGE}/photos` && init.method === "POST") return Response.json({ id: "ph" + (++n) });
    if (u.pathname === `/v27.0/${PAGE}/feed` && init.method === "POST") { posts.push(init.body.get("message")); return Response.json({ id: PAGE + "_" + (900 + posts.length) }); }
    if (u.pathname.startsWith(`/v27.0/${PAGE}_9`)) return Response.json({ permalink_url: "https://www.facebook.com/x/posts/" + u.pathname.split("_")[1] });
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return posts;
}
const api = (path, method = "GET", body) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function runToEnd(env, command) {
  const v = await (await worker.fetch(api("/workflows", "POST", { command }), env)).json();
  let view = v;
  for (let i = 0; i < 10 && view.run.status === "running"; i++) view = await (await worker.fetch(api(`/workflows/${v.run.id}/advance`, "POST"), env)).json();
  return (await (await worker.fetch(api(`/workflows/${v.run.id}`), env)).json());
}

test("content bank: 14 distinct posts for 7 days × 10:30/17:30, plus reserves", () => {
  assert.equal(BANK.week1.length, 14);
  assert.equal(BANK.posts_per_week, 14);
  assert.ok(BANK.reserves.length >= 7);
  assert.equal(new Set(ALL.map(i => i.cid)).size, ALL.length, "content IDs are unique");
  assert.equal(new Set(ALL.map(i => i.topic)).size, ALL.length, "topics are unique");
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    assert.deepEqual(BANK.week1.filter(i => i.day === d).map(i => i.time).sort(), ["10:30", "17:30"], d);
  }
});

test("every bank command is routed to the Cloud creative workflow and carries CID + CTA \"สนใจ\"", () => {
  for (const item of ALL) {
    assert.equal(isCreativeWorkflowIntent(item.command), true, item.cid + " must start Master → Creative → Graphic → post");
    assert.deepEqual(wfDirectives(item.command), { cid: item.cid, cta: "สนใจ" }, item.cid);
    assert.ok(item.command.length <= 1000, item.cid + " fits the 1000-character command limit");
    assert.ok(item.command.includes("ชุมชน HR สายงานสรรหาว่าจ้าง"), item.cid + " names the target Page");
  }
});

test("wfEnsureCta appends the CTA only when missing", () => {
  assert.deepEqual(wfEnsureCta("โพสต์ สนใจคอมเมนต์", "สนใจ"), { caption: "โพสต์ สนใจคอมเมนต์", added: false });
  const r = wfEnsureCta("โพสต์ทดสอบ", "สนใจ");
  assert.equal(r.added, true);
  assert.ok(r.caption.endsWith('👉 คอมเมนต์ "สนใจ" ใต้โพสต์นี้'));
  assert.deepEqual(wfEnsureCta("โพสต์", null), { caption: "โพสต์", added: false });
  assert.deepEqual(wfDirectives("ไม่มีแท็ก"), { cid: null, cta: null });
  assert.equal(wfDirectives('CTA: “สนใจ”').cta, "สนใจ");
});

test("all 21 bank commands run end to end; every published caption contains \"สนใจ\"", async (t) => {
  const posts = graph(t);
  const { env } = await setup();
  for (const item of ALL) {
    const v = await runToEnd(env, item.command);
    assert.equal(v.run.status, "completed", item.cid + ": " + (v.run.error_message || ""));
    assert.equal(v.run.creative.cta.word, "สนใจ");
    assert.equal(v.run.creative.cta.added_by_guard, true);
  }
  assert.equal(posts.length, ALL.length, "one Facebook post per command");
  for (const m of posts) assert.ok(m.includes("สนใจ"));
});

test("a caption that already has the CTA is left unchanged", async (t) => {
  const posts = graph(t);
  const { env } = await setup(fakeAI({ captionHasCta: true }));
  const v = await runToEnd(env, BANK.week1[0].command);
  assert.equal(v.run.creative.cta.added_by_guard, false);
  assert.equal(posts[0].includes("👉"), false);
});

test("the same content ID cannot post twice within 30 days; a new ID can", async (t) => {
  const posts = graph(t);
  const { db, ai, env } = await setup();
  assert.equal((await runToEnd(env, BANK.week1[0].command)).run.status, "completed");
  const aiCalls = ai.calls.length;
  const again = await (await worker.fetch(api("/workflows", "POST", { command: BANK.week1[0].command.replace("ใช้ภาษาเป็นกันเอง", "ใช้ภาษาสุภาพ") }), env)).json();
  assert.equal(again.run.status, "blocked");
  assert.match(again.run.error_message, /Content ID W1-01 ถูกใช้แล้ว/);
  assert.equal(again.events.at(-1).status, "BLOCKED");
  assert.equal(ai.calls.length, aiCalls, "no AI call for a duplicate");
  assert.equal(posts.length, 1, "no second post");
  assert.equal((await runToEnd(env, BANK.week1[1].command)).run.status, "completed");
  // A run older than 30 days no longer blocks the ID.
  db.prepare("UPDATE workflow_runs SET created_at='2000-01-01T00:00:00Z'").run();
  assert.equal((await runToEnd(env, BANK.week1[0].command)).run.status, "completed");
});

test("a failed run does not block a retry with the same content ID", async (t) => {
  graph(t);
  const { db, env } = await setup();
  const first = await (await worker.fetch(api("/workflows", "POST", { command: BANK.week1[2].command }), env)).json();
  db.prepare("UPDATE workflow_runs SET status='failed' WHERE id=?").run(first.run.id);
  assert.equal((await runToEnd(env, BANK.week1[2].command)).run.status, "completed");
});
