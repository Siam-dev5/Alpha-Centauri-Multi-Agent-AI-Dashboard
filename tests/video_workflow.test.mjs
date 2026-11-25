// Video Editor workflow tests: real SQLite (schema + migrations), mocked Workers AI and Graph API.
// Covers: video mode stages, verbatim TEXT/VO, render-node auth, Worker-side QC, exactly-once Facebook video publish.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { wfIsVideo, wfVideoDirectives, wfSubtitleLines, wfVideoQcProblems, runScheduledWorkflows } from "../cloudflare/worker.mjs";

const PAGE = "1333399556514367";
const TOKEN = "render-token-" + "x".repeat(40);
const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RAW_KEY = new Uint8Array(32).fill(5);
const sha = async (v) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64");
const COMMAND = '[VIDEO] [CID:HR2026-C01] ให้ Video Editor ทำคลิปที่ 1 "สงครามคนเก่ง" แล้วโพสต์ลงเพจ TEXT:"ปี 2026 = สงครามแย่งคนเก่ง" VO:"คุณยังคิดว่าลงประกาศแล้วคนจะสมัครอยู่เหรอ?"';
const GOOD_QC = { width: 1080, height: 1920, duration: 6.0, video_codec: "h264", audio_codec: "aac", has_audio: true, subtitles_burned_in: true, character_reference: true };
const mp4 = (size = 80 * 1024) => { const b = new Uint8Array(size); b.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return b; };

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
function fakeAI() {
  const calls = [];
  return { calls, async run(model, input) {
    calls.push({ model, input });
    if (model.includes("flux") || model.includes("lucid")) return { image: JPEG_B64 };
    const sys = input.messages[0].content;
    if (sys.includes("Master Bot")) return { choices: [{ message: { content: JSON.stringify({ summary: "คลิปสั้น", topic: "สงครามคนเก่ง", audience: "HR", tone: "มั่นใจ", creative_brief: "ทำคลิป", graphic_brief: "ฉากมืด นีออน", video_brief: "ตัดเร็ว", social_brief: "โพสต์ 1 ครั้ง" }) } }] };
    return { choices: [{ message: { content: JSON.stringify({ concept: "HR เจอสงครามคนเก่ง", hook_text: "ข้อความที่ AI แต่งเอง", voiceover: "เสียงที่ AI แต่งเอง", caption: "ปี 2026 การแย่งคนเก่งดุเดือดขึ้น\nองค์กรคุณพร้อมหรือยัง?\n#HR #Recruitment #สรรหา", keyframe_prompt: "dark office with floating resumes" }) } }] };
  } };
}
async function setup() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["schema.sql", "0005_meta_webhooks.sql", "0006_facebook_page_publishing.sql", "0007_page_auto_like.sql", "0008_creative_workflow.sql"]) {
    db.exec(readFileSync(new URL(f === "schema.sql" ? "../cloud/social-commerce/schema.sql" : "../migrations/" + f, import.meta.url), "utf8"));
  }
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES('u1','admin@example.test','x','y',?)").run(stamp);
  db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES('s1','u1',?,'2999-01-01T00:00:00Z',?)").run(await sha("session-token"), stamp);
  db.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token,created_at,updated_at) VALUES('acc0','u1','facebook',?,'ชุมชน HR สายงานสรรหาว่าจ้าง','connected','[\"pages_manage_posts\"]','[\"CREATE_CONTENT\"]',?,?,?)")
    .run(PAGE, await encryptToken("PAGE-TOKEN"), stamp, stamp);
  const ai = fakeAI();
  return { db, ai, env: { DB: d1(db), AI: ai, TOKEN_ENCRYPTION_KEY: b64(RAW_KEY), META_APP_SECRET: "secret", META_GRAPH_API_VERSION: "v27.0", VIDEO_RENDER_TOKEN: TOKEN } };
}
function graph(t, { videoError = null, networkError = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "graph-video.facebook.com" && u.pathname === `/v27.0/${PAGE}/videos` && init.method === "POST") {
      const src = init.body.get("source");
      calls.push({ type: "video", published: init.body.get("published"), description: init.body.get("description"), title: init.body.get("title"), bytes: src ? (await src.arrayBuffer()).byteLength : 0, mime: src?.type, proof: !!init.body.get("appsecret_proof") });
      if (networkError) throw new TypeError("network");
      return videoError ? Response.json({ error: { message: videoError } }, { status: 400 }) : Response.json({ id: "777000111" });
    }
    if (u.pathname === "/v27.0/777000111") { calls.push({ type: "permalink" }); return Response.json({ permalink_url: "/reel/777000111/" }); }
    throw new Error("unexpected request " + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const api = (path, method = "GET", body) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, {
  method, headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const node = (path, method = "GET", body, token = TOKEN) => new Request("https://social-api.siamhrbp.com/api/social-commerce" + path, {
  method, headers: token ? { "X-Render-Token": token, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) } : {}, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
const publishForm = (bytes = mp4(), qc = GOOD_QC) => { const f = new FormData(); f.set("video", new Blob([bytes], { type: "video/mp4" }), "clip.mp4"); f.set("qc", JSON.stringify(qc)); return f; };

async function runToRender(env) {
  const created = await (await worker.fetch(api("/workflows", "POST", { command: COMMAND }), env)).json();
  const id = created.run.id;
  for (let i = 0; i < 6; i++) await worker.fetch(api("/workflows/" + id + "/advance", "POST"), env);
  return id;
}

test("helpers: video detection, verbatim directives, Thai subtitle split, QC rules", () => {
  assert.equal(wfIsVideo(COMMAND), true);
  assert.equal(wfIsVideo("ทำคอนเทนต์ภาพปกแล้วโพสต์ลงเพจ"), false);
  assert.deepEqual(wfVideoDirectives(COMMAND), { text: "ปี 2026 = สงครามแย่งคนเก่ง", vo: "คุณยังคิดว่าลงประกาศแล้วคนจะสมัครอยู่เหรอ?" });
  assert.deepEqual(wfVideoDirectives('TEXT:“A” VO:“B”'), { text: "A", vo: "B" });
  assert.deepEqual(wfSubtitleLines("คุณยังคิดว่าลงประกาศแล้วคนจะสมัครอยู่เหรอ?"), ["คุณยังคิดว่าลงประกาศ", "แล้วคนจะสมัครอยู่เหรอ?"]);
  assert.deepEqual(wfSubtitleLines("สั้น ๆ"), ["สั้น ๆ"]);
  assert.deepEqual(wfVideoQcProblems(GOOD_QC, 80 * 1024, mp4().subarray(0, 12)), []);
  const bad = wfVideoQcProblems({ ...GOOD_QC, width: 1920, height: 1080, duration: 15, has_audio: false, subtitles_burned_in: false }, 10, new Uint8Array(12));
  assert.equal(bad.length, 6);
});

test("video run: Master → Creative (verbatim TEXT/VO) → Graphic 9:16 keyframe → waits for Video Editor; advance/cron never post", async (t) => {
  const { db, ai, env } = await setup();
  const calls = graph(t);
  const id = await runToRender(env);
  const run = db.prepare("SELECT status,stage,creative_json FROM workflow_runs WHERE id=?").get(id);
  assert.equal(run.status, "running");
  assert.equal(run.stage, "video_awaiting_render");
  const c = JSON.parse(run.creative_json);
  assert.equal(c.hook_text, "ปี 2026 = สงครามแย่งคนเก่ง");
  assert.equal(c.voiceover, "คุณยังคิดว่าลงประกาศแล้วคนจะสมัครอยู่เหรอ?");
  assert.deepEqual(c.subtitle_lines, ["คุณยังคิดว่าลงประกาศ", "แล้วคนจะสมัครอยู่เหรอ?"]);
  assert.deepEqual(c.spec, { width: 1080, height: 1920, duration: 6, fps: 30 });
  const img = ai.calls.find(x => x.model.includes("lucid"));
  assert.equal(img.input.width, 1080); assert.equal(img.input.height, 1920);
  assert.match(img.input.prompt, /no people/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_assets WHERE run_id=?").get(id).n, 1);
  const handoffs = db.prepare("SELECT from_agent||'>'||to_agent h FROM workflow_events WHERE run_id=? AND status='HANDOFF' ORDER BY seq").all(id).map(r => r.h);
  assert.deepEqual(handoffs, ["master>creative", "creative>graphic", "graphic>video"]);
  const adv = await (await worker.fetch(api("/workflows/" + id + "/advance", "POST"), env)).json();
  assert.equal(adv.advanced, false);
  db.prepare("UPDATE workflow_runs SET updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
  assert.equal(await runScheduledWorkflows(env), 0);
  assert.equal(calls.length, 0, "nothing is posted before the render node hands over a checked file");
});

test("render-node API requires the token and lists / serves the waiting job", async (t) => {
  const { env } = await setup();
  graph(t);
  const id = await runToRender(env);
  assert.equal((await worker.fetch(node("/video-jobs", "GET", null, null), env)).status, 401);
  assert.equal((await worker.fetch(node("/video-jobs", "GET", null, "wrong-token-" + "y".repeat(40)), env)).status, 401);
  assert.equal((await worker.fetch(node("/video-jobs", "GET", null, TOKEN), { ...env, VIDEO_RENDER_TOKEN: "short" })).status, 401);
  const jobs = (await (await worker.fetch(node("/video-jobs"), env)).json()).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.equal(jobs[0].creative.voiceover, "คุณยังคิดว่าลงประกาศแล้วคนจะสมัครอยู่เหรอ?");
  const kf = await worker.fetch(node("/video-jobs/" + id + "/keyframe"), env);
  assert.equal(kf.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await kf.arrayBuffer()).byteLength, 10);
  const ev = await worker.fetch(node("/video-jobs/" + id + "/events", "POST", { status: "QC", message: "ตรวจไฟล์ผ่าน" }), env);
  assert.equal(ev.status, 200);
});

test("publish: Worker QC rejects a bad file without posting; a good file posts exactly once and returns the video ID + permalink", async (t) => {
  const { db, env } = await setup();
  const calls = graph(t);
  const id = await runToRender(env);
  const bad = await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm(mp4(), { ...GOOD_QC, duration: 12 })), env);
  assert.equal(bad.status, 422);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT stage FROM workflow_runs WHERE id=?").get(id).stage, "video_awaiting_render");
  const ok = await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm()), env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.video_id, "777000111");
  assert.equal(body.permalink, "https://www.facebook.com/reel/777000111/");
  const up = calls.filter(c => c.type === "video");
  assert.equal(up.length, 1);
  assert.equal(up[0].published, "true");
  assert.equal(up[0].mime, "video/mp4");
  assert.equal(up[0].bytes, 80 * 1024);
  assert.equal(up[0].title, "ปี 2026 = สงครามแย่งคนเก่ง");
  assert.match(up[0].description, /#HR/);
  assert.equal(up[0].proof, true);
  const run = db.prepare("SELECT status,stage,post_id,permalink FROM workflow_runs WHERE id=?").get(id);
  assert.deepEqual({ ...run }, { status: "completed", stage: "published", post_id: "777000111", permalink: "https://www.facebook.com/reel/777000111/" });
  assert.equal(db.prepare("SELECT status FROM publish_records WHERE idempotency_key=?").get("wfv_" + id).status, "published");
  const again = await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm()), env);
  assert.equal(again.status, 409);
  assert.equal(calls.filter(c => c.type === "video").length, 1, "a second upload never posts again");
  const handoffs = db.prepare("SELECT from_agent||'>'||to_agent h FROM workflow_events WHERE run_id=? AND status='HANDOFF' ORDER BY seq").all(id).map(r => r.h);
  assert.deepEqual(handoffs, ["master>creative", "creative>graphic", "graphic>video", "video>social"]);
});

test("publish failures are recorded once and never retried; render-node fail stops the run without posting", async (t) => {
  const { db, env } = await setup();
  const calls = graph(t, { videoError: "Invalid video" });
  const id = await runToRender(env);
  const r = await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm()), env);
  assert.equal(r.status, 502);
  assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id=?").get(id).status, "failed");
  assert.equal(db.prepare("SELECT status FROM publish_records WHERE idempotency_key=?").get("wfv_" + id).status, "failed");
  assert.equal((await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm()), env)).status, 409);
  assert.equal(calls.filter(c => c.type === "video").length, 1);

  const second = await setup();
  const calls2 = graph(t);
  const id2 = await runToRender(second.env);
  const f = await worker.fetch(node("/video-jobs/" + id2 + "/fail", "POST", { message: "TTS ไม่พร้อม" }), second.env);
  assert.equal(f.status, 200);
  assert.equal(second.db.prepare("SELECT status FROM workflow_runs WHERE id=?").get(id2).status, "failed");
  assert.equal(calls2.length, 0);
});

test("network error during upload marks the record unknown and does not retry", async (t) => {
  const { db, env } = await setup();
  graph(t, { networkError: true });
  const id = await runToRender(env);
  const r = await worker.fetch(node("/video-jobs/" + id + "/publish", "POST", publishForm()), env);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /may exist/);
  assert.equal(db.prepare("SELECT status FROM publish_records WHERE idempotency_key=?").get("wfv_" + id).status, "unknown");
});
