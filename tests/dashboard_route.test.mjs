import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare/worker.mjs";

const DASHBOARD_HTML = "<!doctype html><title>Alpha Centauri</title>";

function fakeDb() {
  const stmt = {
    bind() { return stmt; },
    async first() { return { n: 1 }; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 0 } }; }
  };
  return { prepare() { return stmt; } };
}

function env(withAssets = true) {
  const calls = [];
  const e = { DB: fakeDb(), BOOTSTRAP_KEY: "k", TOKEN_ENCRYPTION_KEY: "k" };
  if (withAssets) {
    e.ASSETS = {
      calls,
      async fetch(req) {
        calls.push(new URL(req.url).pathname);
        return new Response(DASHBOARD_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    };
  }
  return e;
}

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const req = (path, accept, method = "GET") =>
  new Request("https://social-api.siamhrbp.com" + path, { method, headers: accept ? { Accept: accept } : {} });

test("browser navigation to / receives the Dashboard HTML", async () => {
  const e = env();
  const res = await worker.fetch(req("/", BROWSER_ACCEPT), e);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/html/);
  assert.equal(res.headers.get("Vary"), "Accept");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(await res.text(), DASHBOARD_HTML);
  assert.deepEqual(e.ASSETS.calls, ["/"]);
});

test("API clients calling / keep the JSON health response", async () => {
  for (const accept of [undefined, "*/*", "application/json"]) {
    const e = env();
    const res = await worker.fetch(req("/", accept), e);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.service, "Alpha Centauri Social Commerce Cloud API");
    assert.equal(body.status, "online");
    assert.deepEqual(e.ASSETS.calls, []);
  }
});

test("prefixed and /health routes stay JSON even for browsers", async () => {
  for (const path of ["/health", "/api/social-commerce", "/api/social-commerce/", "/api/social-commerce/health"]) {
    const e = env();
    const res = await worker.fetch(req(path, BROWSER_ACCEPT), e);
    assert.match(res.headers.get("Content-Type"), /application\/json/, path);
    assert.deepEqual(e.ASSETS.calls, [], path);
  }
});

test("authenticated API routes are not shadowed by the Dashboard", async () => {
  const res = await worker.fetch(req("/api/social-commerce/status", BROWSER_ACCEPT), env());
  assert.equal(res.status, 401);
});

test("without an ASSETS binding the root stays JSON", async () => {
  const res = await worker.fetch(req("/", BROWSER_ACCEPT), env(false));
  assert.match(res.headers.get("Content-Type"), /application\/json/);
});

test("CORS allows both Dashboard origins and nothing else", async () => {
  for (const origin of ["https://siam-dev5.github.io", "https://social-api.siamhrbp.com"]) {
    const res = await worker.fetch(new Request("https://social-api.siamhrbp.com/api/social-commerce/health", { method: "OPTIONS", headers: { Origin: origin } }), env());
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
  }
  const bad = await worker.fetch(new Request("https://social-api.siamhrbp.com/api/social-commerce/health", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env());
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
});
