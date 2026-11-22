// Activity log: Cloud workflow runs are restored from the backend after a refresh, followed live, viewable per run,
// and every server event (run + seq) appears once. Runs the real dashboard functions in a VM with a minimal DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).find(s => s.includes("function addActivityLog"));

function element(id) {
  return { id, innerHTML: "", textContent: "", value: "", className: "", dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, addEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; }, setAttribute() {}, getAttribute() { return null; } };
}
function dashboard(api) {
  const els = new Map();
  const document = { hidden: false, getElementById: (id) => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); },
    querySelectorAll: () => [], querySelector: () => null, createElement: (t) => element(t), addEventListener() {}, body: element("body") };
  const store = new Map([["sc_session", "token"]]);
  const sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const ctx = { document, sessionStorage, localStorage: sessionStorage, console, setInterval: () => 0, clearInterval() {}, setTimeout: (f) => { f(); return 0; },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), Image: function () {}, WebSocket: function () {}, requestAnimationFrame: () => 0, navigator: {}, fetch: async () => ({ ok: false }), alert() {}, confirm: () => false, lucide: { createIcons() {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__t = { addActivityLog, renderLogs, setRunFilter, wfRecordEvents, wfSyncRuns, get logs(){return logs;}, wfRuns, wfFollowing };", ctx);
  // the test drives the API; never touches the network
  vm.runInContext("scRequest = async (path, options) => __api(path, options); appendChatBubble = () => {}; updateAgentState = () => {}; setConnection = () => {}; showToast = () => {}; appendWorkflowResultCard = async () => {};", Object.assign(ctx, { __api: api }));
  return { t: ctx.__t, els };
}
const ev = (seq, status = "WORKING") => ({ seq, from_agent: "master", to_agent: "creative", status, message: "m" + seq, created_at: new Date(Date.UTC(2026, 10, 22, 10, 0, seq)).toISOString() });
const run = (id, status, extra = {}) => ({ id, command: "cmd " + id, status, stage: status === "completed" ? "published" : "planned", created_at: "2026-11-22T10:00:0" + id.length + "Z", ...extra });

test("the dashboard script wires restore, live follow and the per-run selector", () => {
  assert.ok(script, "dashboard script found");
  assert.ok(html.includes('id="log-run-filter"'));
  assert.ok(script.includes("wfStartSync();"), "restore runs on load / login");
  assert.ok(script.includes("wfStopSync();"), "stop sync on logout");
  assert.ok(script.includes("key: 'wf:' + runId + ':' + e.seq"), "log entries keyed by run + seq");
});

test("same server event logged once whatever the source (live, restore, sync)", () => {
  const { t } = dashboard(async () => ({}));
  const r = run("runA", "running");
  t.wfRecordEvents(r, [ev(1), ev(2)]);
  t.wfRecordEvents(r, [ev(2), ev(3)]);
  t.wfRecordEvents(r, [ev(1), ev(2), ev(3)], { replay: true });
  const mine = t.logs.filter(l => l.runId === "runA");
  assert.equal(mine.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.map(l => l.seq))), [3, 2, 1], "newest first by server time");
});

test("restore after refresh: completed runs replayed from history, running runs followed; per-run filter", async () => {
  const views = {
    done: { run: run("done", "completed"), events: [ev(1, "RECEIVED"), ev(2, "HANDOFF"), ev(3, "COMPLETED")], assets: [] },
    live: { run: run("live1", "running"), events: [ev(1, "RECEIVED")], assets: [] },
  };
  const calls = [];
  let liveStatus = "running";
  const { t, els } = dashboard(async (path) => {
    calls.push(path);
    if (path === "/workflows") return { runs: [views.live.run, views.done.run] };
    if (path.startsWith("/workflows/done")) return views.done;
    if (path.startsWith("/workflows/live1/advance")) { liveStatus = "completed"; return { advanced: true, run: { ...views.live.run, status: "completed", stage: "published" }, events: [ev(2, "HANDOFF"), ev(3, "COMPLETED")], assets: [] }; }
    if (path.startsWith("/workflows/live1")) return { run: { ...views.live.run, status: liveStatus }, events: liveStatus === "running" ? [ev(1, "RECEIVED")] : [ev(1, "RECEIVED"), ev(2, "HANDOFF"), ev(3, "COMPLETED")], assets: [] };
    throw new Error("unexpected " + path);
  });
  await t.wfSyncRuns({ initial: true });
  for (let i = 0; i < 20 && t.wfFollowing.size; i++) await new Promise(r => setImmediate(r));
  assert.equal(t.logs.filter(l => l.runId === "done").length, 3);
  assert.equal(t.logs.filter(l => l.runId === "live1").length, 3);
  assert.ok(t.logs.filter(l => l.runId === "done").every(l => l.message.startsWith("[บันทึก ")), "history is labelled as restored");
  assert.ok(!calls.some(p => p.startsWith("/workflows/done/advance")), "a finished run is never advanced again");
  assert.equal(t.wfRuns.get("live1").run.status, "completed");

  t.setRunFilter("done");
  assert.equal(els.get("log-count").textContent, "3 รายการ");
  t.setRunFilter("ALL");
  assert.equal(els.get("log-count").textContent, "6 รายการ", "ALL shows both runs (2 × 3 events)");

  // a second sync (no changes) adds nothing
  await t.wfSyncRuns();
  assert.equal(t.logs.filter(l => l.runId).length, 6);
});
