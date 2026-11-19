import test from "node:test";
import assert from "node:assert/strict";
import { verifyMetaSignature, buildMetaAuthorizationUrl } from "../cloudflare/worker.mjs";
import { createHmac } from "node:crypto";

test("Meta webhook signature accepts the exact raw body", async () => {
  const body = '{"object":"page","entry":[]}';
  const secret = "unit-test-app-secret";
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await verifyMetaSignature(body, signature, secret), true);
  assert.equal(await verifyMetaSignature(body + " ", signature, secret), false);
});

test("Meta webhook signature rejects missing or malformed headers", async () => {
  assert.equal(await verifyMetaSignature("{}", "", "secret"), false);
  assert.equal(await verifyMetaSignature("{}", "sha1=deadbeef", "secret"), false);
});

test("Meta authorization URL uses exact redirect URI and configured scopes", () => {
  const env = {
    META_APP_ID: "123456",
    META_APP_SECRET: "not-used-in-url",
    META_REDIRECT_URI: "https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback",
    META_GRAPH_API_VERSION: "v27.0",
    META_OAUTH_SCOPES: "pages_show_list,instagram_basic"
  };
  const url = new URL(buildMetaAuthorizationUrl(env, "state-value"));
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v27.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "123456");
  assert.equal(url.searchParams.get("redirect_uri"), env.META_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("scope"), "pages_show_list,instagram_basic");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("Meta authorization URL refuses missing app credentials", () => {
  assert.throws(() => buildMetaAuthorizationUrl({ META_APP_ID: "123" }, "state"), /not configured/);
});
