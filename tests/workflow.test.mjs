// Cloud creative workflow tests: real SQLite (schema + migrations), mocked Workers AI and Graph API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { extractJsonObject, runScheduledWorkflows } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(5);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64");

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
function fakeAI({ badJson = false, delayMs = 0 } = {}) {
  const calls = [];
  return { calls, async run(model, input) {
    calls.push(model);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (model.includes("flux") || model.includes("lucid")) return { image: JPEG_B64 };
    const sys = input.messages[0].content;
    if (badJson) return { choices: [{ message: { content: "ขออภัย ไม่สามารถตอบเป็น JSON ได้" } }] };
    if (sys.includes("Master Bot")) return { choices: [{ message: { content: "```json\n" + JSON.stringify({ summary: "แผนทดสอบ", topic: "เคล็ดลับ JD", audience: "HR", tone: "เป็นกันเอง", creative_brief: "คิดคอนเซปต์ JD", graphic_brief: "โทนฟ้า", social_brief: "โพสต์ช่วงเย็น" }) + "\n```" } }] };
    return { choices: [{ message: { content: JSON.stringify({ concept: "JD ที่ดีดึงดูดคนเก่ง", script: ["เปิดด้วยปัญหา", "เคล็ดลับ 3 ข้อ", "ชวนคอมเมนต์"], caption: "เขียน JD ให้ปังด้วย 3 เคล็ดลับ ✨\nชัดเจน กระชับ น่าสนใจ\n#HR #Recruitment #JobDescription", cover_prompt: "recruiter at desk", illustration_prompt: "checklist icons", banner_prompt: "wide blue banner" }) } }] };
  } };
}
async function setup({ pages = 1, ai = fakeAI() } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["schema.sql", "0005_meta_webhooks.sql", "0006_facebook_page_publishing.sql", "0007_page_auto_like.sql", "0008_creative_workflow.sql"]) {
    db.exec(readFileSync(new URL(f === "schema.sql" ? "../cloud/social-commerce/schema.sql" : "../migrations/" + f, import.meta.url), "utf8"));
  }
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  const enc = await encryptToken("PAGE-TOKEN");
  for (let i = 0; i < pages; i++) {
    db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES(?,'u1','facebook',?,?,'connected','[\"pages_manage_posts\"]','[\"CREATE_CONTENT\"]',?,?,?)")
      .run("acc" + i, i ? "555" + i : PAGE, i ? "Other Page " + i : "ชุมชน HR สายงานสรรหาว่าจ้าง", enc, stamp, stamp);
  }
  return { db, ai, env: { DB: d1(db), AI: ai, TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0" } };
}
function graph(t, { feedError = null } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  let photo = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === `/v27.0/${PAGE}/photos` && init.method === "POST") {
      calls.push({ type: "photo", published: init.body.get("published"), hasSource: !!init.body.get("source"), token: init.body.get("access_token") });
      return Response.json({ id: "ph" + (++photo) });
    }
    if (u.pathname === `/v27.0/${PAGE}/feed` && init.method === "POST") {
      const media = [0, 1, 2].map(i => init.body.get(`attached_media[${i}]`));
      calls.push({ type: "feed", message: init.body.get("message"), media });
      return feedError ? Response.json({ error: { message: feedError } }, { status: 400 }) : Response.json({ id: PAGE + "_900" });
    }
    if (u.pathname === `/v27.0/${PAGE}_900`) return Response.json({ permalink_url: "https://www.facebook.com/x/posts/900" });
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const api = (path, method = "GET", body) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const start = async (env) => (await (await worker.fetch(api("/workflows", "POST", { command: "ให้ทีมทำคอนเทนต์เคล็ดลับเขียน JD แล้วโพสต์ลงเพจ" }), env)).json());
const advance = async (env, id) => (await (await worker.fetch(api(`/workflows/${id}/advance`, "POST"), env)).json());

test("extractJsonObject handles fenced and surrounded JSON", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJsonObject("ok {\"b\":2} done"), { b: 2 });
  assert.equal(extractJsonObject("no json"), null);
});

test("full run: Master -> Creative -> Graphic (3 images) -> แอดมินโซเชียล posts once", async (t) => {
  const { db, env, ai } = await setup();
  const calls = graph(t);
  const created = await start(env);
  assert.equal(created.run.status, "running");
  assert.equal(created.run.account_name, "ชุมชน HR สายงานสรรหาว่าจ้าง");
  let view;
  for (let i = 0; i < 7; i++) view = await advance(env, created.run.id);
  assert.equal(view.run.status, "completed");
  assert.equal(view.run.post_id, PAGE + "_900");
  assert.equal(view.run.permalink, "https://www.facebook.com/x/posts/900");
  assert.deepEqual(view.assets.map(a => a.kind).sort(), ["banner", "cover", "illustration"]);
  assert.ok(view.assets.every(a => a.fb_photo_id));

  // Graph: 3 unpublished photo uploads, then exactly one feed post with all 3 attached and the Creative caption.
  assert.deepEqual(calls.map(c => c.type), ["photo", "photo", "photo", "feed"]);
  assert.ok(calls.slice(0, 3).every(c => c.published === "false" && c.hasSource && c.token === "PAGE-TOKEN"));
  assert.deepEqual(calls[3].media, ['{"media_fbid":"ph1"}', '{"media_fbid":"ph2"}', '{"media_fbid":"ph3"}']);
  assert.match(calls[3].message, /เคล็ดลับ/);
  assert.deepEqual(ai.calls, ["@cf/aisingapore/gemma-sea-lion-v4-27b-it", "@cf/aisingapore/gemma-sea-lion-v4-27b-it", "@cf/black-forest-labs/flux-1-schnell", "@cf/black-forest-labs/flux-1-schnell", "@cf/leonardo/lucid-origin"]);

  // Ordered, timestamped handoff trail.
  const all = (await (await worker.fetch(api(`/workflows/${created.run.id}`), env)).json()).events;
  const trail = all.map(e => `${e.from_agent}>${e.to_agent}:${e.status}`);
  assert.deepEqual(trail, [
    "user>master:RECEIVED", "master>master:TARGET", "master>master:WORKING", "master>creative:HANDOFF",
    "creative>creative:WORKING", "creative>graphic:HANDOFF",
    "graphic>graphic:WORKING", "graphic>graphic:DONE", "graphic>graphic:WORKING", "graphic>graphic:DONE",
    "graphic>graphic:WORKING", "graphic>graphic:DONE", "graphic>social:HANDOFF",
    "social>social:WORKING", "social>social:UPLOADED", "social>master:DONE", "master>user:COMPLETED"]);
  assert.ok(all.every((e, i) => e.seq === i + 1 && !Number.isNaN(Date.parse(e.created_at))));

  // Ledger + audit; further advances do nothing and never re-post.
  assert.equal(db.prepare("SELECT status FROM publish_records").get().status, "published");
  assert.equal(db.prepare("SELECT status FROM content_items").get().status, "published");
  const again = await advance(env, created.run.id);
  assert.equal(again.advanced, false);
  assert.equal(calls.length, 4);
  const events = db.prepare("SELECT event_type FROM audit_events ORDER BY created_at").all().map(r => r.event_type);
  assert.deepEqual(events, ["workflow_started", "content_approve", "facebook_post_published"]);

  // Asset route serves the stored JPEG to the owner.
  const img = await worker.fetch(api(`/workflows/${created.run.id}/assets/banner`), env);
  assert.equal(img.headers.get("Content-Type"), "image/jpeg");
  assert.equal(Buffer.from(await img.arrayBuffer()).subarray(0, 2).toString("hex"), "ffd8");
});

test("several ready Pages without a named target block the run before any AI call", async (t) => {
  const { env, ai } = await setup({ pages: 2 });
  graph(t);
  const created = await start(env);
  assert.equal(created.run.status, "blocked");
  assert.match(created.run.error_message, /หลายเพจ/);
  assert.equal((await advance(env, created.run.id)).advanced, false);
  assert.equal(ai.calls.length, 0);
});

test("a named Page resolves the ambiguity", async (t) => {
  const { env } = await setup({ pages: 2 });
  graph(t);
  const res = await worker.fetch(api("/workflows", "POST", { command: "ทำคอนเทนต์แล้วโพสต์ลงเพจ ชุมชน HR สายงานสรรหาว่าจ้าง" }), env);
  const view = await res.json();
  assert.equal(view.run.status, "running");
  assert.equal(view.run.page_id, PAGE);
});

test("a Facebook error fails the run once and is never retried", async (t) => {
  const { db, env } = await setup();
  const calls = graph(t, { feedError: "(#200) Permissions error" });
  const created = await start(env);
  let view;
  for (let i = 0; i < 7; i++) view = await advance(env, created.run.id);
  assert.equal(view.run.status, "failed");
  assert.match(view.run.error_message, /Permissions error/);
  assert.equal(db.prepare("SELECT status FROM publish_records").get().status, "failed");
  await advance(env, created.run.id);
  await runScheduledWorkflows(env);
  assert.equal(calls.filter(c => c.type === "feed").length, 1);
});

test("invalid AI output fails the stage with a logged event", async (t) => {
  const { env } = await setup({ ai: fakeAI({ badJson: true }) });
  graph(t);
  const created = await start(env);
  const view = await advance(env, created.run.id);
  assert.equal(view.run.status, "failed");
  assert.ok(view.events.some(e => e.status === "FAILED" && /not valid JSON/.test(e.message)));
});

test("concurrent advance calls execute only one stage", async (t) => {
  const { env } = await setup({ ai: fakeAI({ delayMs: 80 }) });
  graph(t);
  const created = await start(env);
  const [a, b] = await Promise.all([advance(env, created.run.id), advance(env, created.run.id)]);
  assert.equal([a.advanced, b.advanced].filter(Boolean).length, 1);
  const view = (await (await worker.fetch(api(`/workflows/${created.run.id}`), env)).json());
  assert.equal(view.run.stage, "planned");
});

test("cron resumes a stale running workflow to completion", async (t) => {
  const { db, env } = await setup();
  const calls = graph(t);
  const created = await start(env);
  db.prepare("UPDATE workflow_runs SET updated_at='2000-01-01T00:00:00Z'").run();
  await runScheduledWorkflows(env);
  assert.equal(db.prepare("SELECT status FROM workflow_runs").get().status, "completed");
  assert.equal(calls.filter(c => c.type === "feed").length, 1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE actor='workflow_cron'").get().n >= 1);
});

test("workflow routes require a session", async () => {
  const { env } = await setup();
  for (const [p, m] of [["/workflows", "POST"], ["/workflows", "GET"], ["/workflows/x/advance", "POST"], ["/workflows/x/assets/cover", "GET"]]) {
    const res = await worker.fetch(new Request("https://social-api.siamhrbp.com/api/social-commerce" + p, { method: m }), env);
    assert.equal(res.status, 401, p);
  }
});
