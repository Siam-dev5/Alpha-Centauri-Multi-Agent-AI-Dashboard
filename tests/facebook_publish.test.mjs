// Facebook publish route tests. The Graph API is mocked: no request leaves the test process.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { facebookPublishUrl } from "../cloudflare/worker.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const KEY = b64(new Uint8Array(32).fill(7));

async function encryptToken(value) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(new Uint8Array(32).fill(7)), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(1);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("alpha-centauri-social-v1") }, key, new TextEncoder().encode(value));
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}

async function makeEnv({ contentStatus = "approved", body = "Hello Everyone" } = {}) {
  const encrypted = await encryptToken("PAGE-TOKEN-TEST");
  const writes = [];
  const DB = {
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async first() {
          if (sql.includes("FROM user_sessions")) return { id: "u1", email: "admin@example.test", expires_at: "2999-01-01T00:00:00Z" };
          if (sql.includes("FROM content_items")) return { id: "c1", title: "t", body, status: contentStatus, platforms_json: '["facebook"]', account_ids_json: '["a1"]' };
          if (sql.includes("FROM social_accounts")) return { id: "a1", external_account_id: "1333399556514367", account_name: "Test Page", status: "connected", scopes_json: '["pages_manage_posts"]', page_tasks_json: '["CREATE_CONTENT"]', encrypted_access_token: encrypted };
          if (sql.includes("FROM publish_records WHERE content_id=? AND account_id=?")) return null;
          if (sql.includes("COUNT(*) total")) return { total: 1, published: 1 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { writes.push(sql); return { meta: { changes: 1 } }; }
      };
      return stmt;
    }
  };
  return { DB, writes, TOKEN_ENCRYPTION_KEY: KEY, META_APP_SECRET: "app-secret", META_GRAPH_API_VERSION: "v27.0" };
}

function mockGraph(t, responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const publishRequest = (body, headers = {}) => new Request("https://social-api.siamhrbp.com/api/social-commerce/content/c1/publish/a1", {
  method: "POST",
  headers: { Authorization: "Bearer session", "Idempotency-Key": "abcdefghijklmnop1234", ...headers },
  body
});

test("publish URL uses the feed edge for text and photos edge for images", () => {
  const env = { META_GRAPH_API_VERSION: "v27.0" };
  assert.equal(facebookPublishUrl(env, "123", "text"), "https://graph.facebook.com/v27.0/123/feed");
  assert.equal(facebookPublishUrl(env, "123", "photo"), "https://graph.facebook.com/v27.0/123/photos");
});

test("text-only chat post goes to /feed with the message and no image", async (t) => {
  const env = await makeEnv();
  const calls = mockGraph(t, (url) => url.includes("/feed")
    ? Response.json({ id: "1333399556514367_999" })
    : Response.json({ permalink_url: "https://www.facebook.com/1333399556514367/posts/999" }));
  const res = await worker.fetch(publishRequest(JSON.stringify({ post_kind: "text" }), { "Content-Type": "application/json" }), env);
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.post_kind, "text");
  assert.equal(out.post_id, "1333399556514367_999");
  assert.equal(out.permalink, "https://www.facebook.com/1333399556514367/posts/999");
  const post = calls[0];
  assert.equal(post.url, "https://graph.facebook.com/v27.0/1333399556514367/feed");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.body.get("message"), "Hello Everyone");
  assert.equal(post.init.body.get("access_token"), "PAGE-TOKEN-TEST");
  assert.ok(post.init.body.get("appsecret_proof"));
  assert.equal(post.init.body.has("source"), false);
  assert.ok(env.writes.some(s => s.includes("UPDATE publish_records SET status='published'")));
});

test("multipart with a PNG still publishes through /photos", async (t) => {
  const env = await makeEnv();
  const calls = mockGraph(t, (url) => url.includes("/photos")
    ? Response.json({ id: "photo1", post_id: "1333399556514367_777" })
    : Response.json({}));
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "x.png");
  const res = await worker.fetch(publishRequest(form), env);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).post_kind, "photo");
  assert.equal(calls[0].url, "https://graph.facebook.com/v27.0/1333399556514367/photos");
  assert.ok(calls[0].init.body.get("source"));
});

test("unsupported image types are rejected before any Graph call", async (t) => {
  const env = await makeEnv();
  const calls = mockGraph(t, () => Response.json({}));
  const form = new FormData();
  form.append("image", new Blob(["GIF89a"], { type: "image/gif" }), "x.gif");
  const res = await worker.fetch(publishRequest(form), env);
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
});

test("unapproved content is never sent to Facebook", async (t) => {
  const env = await makeEnv({ contentStatus: "pending_approval" });
  const calls = mockGraph(t, () => Response.json({ id: "should-not-happen" }));
  const res = await worker.fetch(publishRequest(JSON.stringify({}), { "Content-Type": "application/json" }), env);
  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
});

test("a Facebook error is reported as failed, not published", async (t) => {
  const env = await makeEnv();
  mockGraph(t, () => Response.json({ error: { message: "(#200) Permissions error" } }, { status: 403 }));
  const res = await worker.fetch(publishRequest(JSON.stringify({}), { "Content-Type": "application/json" }), env);
  assert.equal(res.status, 502);
  const out = await res.json();
  assert.equal(out.publish_status, "failed");
  assert.ok(env.writes.some(s => s.includes("status='failed'")));
});
