// Always-on campaign scheduler: real SQLite (schema + migrations), mocked Workers AI and Graph API.
// Nothing leaves the process; every "post" goes to the fake Graph API below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { campaignDueSlot, pickNextCampaignItem, runCampaignScheduler, CAMPAIGN_SLOTS_UTC } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
const BANK = JSON.parse(readFileSync(new URL("../content/routine-content-bank.json", import.meta.url), "utf8"));
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(5);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64");
const at = (iso) => new Date(iso);

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
const ai = { calls: 0, async run(model, input) {
  this.calls++;
  if (model.includes("flux") || model.includes("lucid")) return { image: JPEG_B64 };
  if (input.messages[0].content.includes("Master Bot")) return { choices: [{ message: { content: JSON.stringify({ summary: "s", topic: "t", audience: "HR", tone: "เป็นกันเอง", creative_brief: "brief" }) } }] };
  return { choices: [{ message: { content: JSON.stringify({ concept: "c", caption: "แคปชันทดสอบสำหรับคนทำงาน HR สายสรรหา 3 ข้อ", cover_prompt: "a", illustration_prompt: "b", banner_prompt: "c" }) } }] };
} };
function graph(t, { feedError = null } = {}) {
  const posts = [];
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === `/v27.0/${PAGE}/photos`) return Response.json({ id: "ph" + (++n) });
    if (u.pathname === `/v27.0/${PAGE}/feed`) {
      if (feedError) return Response.json({ error: { message: feedError } }, { status: 400 });
      posts.push(init.body.get("message")); return Response.json({ id: PAGE + "_" + (900 + posts.length) });
    }
    if (u.pathname.startsWith(`/v27.0/${PAGE}_9`)) return Response.json({ permalink_url: "https://www.facebook.com/x/posts/" + u.pathname.split("_")[1] });
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return posts;
}
async function setup(t, { enabled = true, feedError = null } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["../cloud/social-commerce/schema.sql", "../migrations/0005_meta_webhooks.sql", "../migrations/0006_facebook_page_publishing.sql", "../migrations/0007_page_auto_like.sql", "../migrations/0008_creative_workflow.sql"]) db.exec(readFileSync(new URL(f, import.meta.url), "utf8"));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES('acc0','u1','facebook',?,?,'connected','[\"pages_manage_posts\"]','[\"CREATE_CONTENT\"]',?,?,?)")
    .run(PAGE, "ชุมชน HR สายงานสรรหาว่าจ้าง", await encryptToken("PAGE-TOKEN"), stamp, stamp);
  const posts = graph(t, { feedError });
  const env = { DB: d1(db), AI: ai, TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0", ...(enabled ? { CAMPAIGN_SCHEDULER: "on" } : {}) };
  return { db, env, posts };
}
const ALL = [...BANK.week1, ...BANK.reserves];

test("slots map 10:30 and 17:30 Asia/Bangkok to 03:30 and 10:30 UTC, with a 60-minute window", () => {
  assert.deepEqual(CAMPAIGN_SLOTS_UTC.map(s => s.label + "=" + s.h + ":" + s.m), ["10:30=3:30", "17:30=10:30"]);
  assert.equal(campaignDueSlot(at("2026-11-25T03:29:59Z")), null);
  assert.equal(campaignDueSlot(at("2026-11-25T03:30:00Z")).key, "2026-11-25@10:30");
  assert.equal(campaignDueSlot(at("2026-11-25T04:29:00Z")).key, "2026-11-25@10:30");
  assert.equal(campaignDueSlot(at("2026-11-25T04:30:00Z")), null);
  assert.equal(campaignDueSlot(at("2026-11-25T10:35:00Z")).key, "2026-11-25@17:30");
  assert.equal(campaignDueSlot(at("2026-11-25T17:00:00Z")), null);
});

test("pickNextCampaignItem returns the first content ID never used (week first, then reserves)", () => {
  assert.equal(pickNextCampaignItem(BANK, new Set()).cid, "W1-01");
  assert.equal(pickNextCampaignItem(BANK, new Set(["W1-01", "W1-02"])).cid, "W1-03");
  assert.equal(pickNextCampaignItem(BANK, new Set(BANK.week1.map(i => i.cid))).cid, "R-01");
  assert.equal(pickNextCampaignItem(BANK, new Set(ALL.map(i => i.cid))), null);
});

test("off by default: no run, no AI call, no post", async (t) => {
  const { db, env, posts } = await setup(t, { enabled: false });
  const before = ai.calls;
  assert.deepEqual(await runCampaignScheduler(env, at("2026-11-25T03:31:00Z")), { skipped: "disabled" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n, 0);
  assert.equal(ai.calls, before);
  assert.equal(posts.length, 0);
});

test("a due slot posts exactly once, server-side, with the next unused CID", async (t) => {
  const { db, env, posts } = await setup(t);
  const r = await runCampaignScheduler(env, at("2026-11-25T03:31:00Z"));
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.cid, "W1-01");
  assert.equal(posts.length, 1);
  assert.ok(posts[0].includes("สนใจ"), "CTA guard still applies");
  const again = await runCampaignScheduler(env, at("2026-11-25T03:36:00Z"));
  assert.equal(again.skipped, "slot already handled");
  assert.equal(posts.length, 1, "the next cron tick in the same slot posts nothing");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='campaign_slot'").get().n, 1);
  const evening = await runCampaignScheduler(env, at("2026-11-25T10:31:00Z"));
  assert.equal(evening.cid, "W1-02");
  assert.equal(posts.length, 2);
  assert.equal((await runCampaignScheduler(env, at("2026-11-25T12:00:00Z"))).skipped, "no slot due");
});

test("a slot already posted by the OpenBot routine (any run since slot-30min) is not posted again", async (t) => {
  const { db, env, posts } = await setup(t);
  const api = new Request("https://social-api.siamhrbp.com/api/social-commerce/workflows", { method: "POST", headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: JSON.stringify({ command: BANK.week1[2].command }) });
  await worker.fetch(api, env);
  db.prepare("UPDATE workflow_runs SET created_at='2026-11-25T03:20:00Z'").run();
  const r = await runCampaignScheduler(env, at("2026-11-25T03:35:00Z"));
  assert.equal(r.skipped, "slot already has a run");
  assert.equal(posts.length, 0);
});

test("content IDs are never reused across days; an exhausted bank posts nothing", async (t) => {
  const { db, env, posts } = await setup(t);
  for (let i = 0; i < ALL.length; i++) {
    const day = String(1 + Math.floor(i / 2)).padStart(2, "0");
    const r = await runCampaignScheduler(env, at(`2026-12-${day}T${i % 2 ? "10" : "03"}:31:00Z`));
    assert.equal(r.status, "completed", JSON.stringify(r));
  }
  assert.equal(posts.length, ALL.length);
  const cids = db.prepare("SELECT command FROM workflow_runs").all().map(r => r.command.match(/\[CID:([^\]]+)\]/)[1]);
  assert.equal(new Set(cids).size, ALL.length, "21 distinct content IDs");
  const r = await runCampaignScheduler(env, at("2026-12-20T03:31:00Z"));
  assert.equal(r.error, "content bank exhausted");
  assert.equal(posts.length, ALL.length);
});

test("a Facebook error fails the run once; the slot is not retried and nothing double-posts", async (t) => {
  const { env, posts } = await setup(t, { feedError: "(#200) test failure" });
  const r = await runCampaignScheduler(env, at("2026-11-25T03:31:00Z"));
  assert.equal(r.status, "failed");
  assert.equal((await runCampaignScheduler(env, at("2026-11-25T03:40:00Z"))).skipped, "slot already handled");
  assert.equal(posts.length, 0);
});

test("the scheduled() handler runs the campaign when enabled", async (t) => {
  const { env, posts } = await setup(t);
  const pending = [];
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ["2026-11-25T03:32:00Z"])); } static now() { return new RealDate("2026-11-25T03:32:00Z").getTime(); } };
  t.after(() => { globalThis.Date = RealDate; });
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.allSettled(pending);
  globalThis.Date = RealDate;
  assert.equal(posts.length, 1);
});
