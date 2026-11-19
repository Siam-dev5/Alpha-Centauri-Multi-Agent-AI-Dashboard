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

test("Instagram Unified Login uses its configuration ID and omits scope", () => {
  const env = {
    META_APP_ID: "123456",
    META_APP_SECRET: "not-used-in-url",
    META_REDIRECT_URI: "https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback",
    META_GRAPH_API_VERSION: "v27.0",
    META_IG_CONFIG_ID: "ig-config-001",
    META_FB_CONFIG_ID: "fb-config-002"
  };
  const url = new URL(buildMetaAuthorizationUrl(env, "state-value", "instagram"));
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v27.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "123456");
  assert.equal(url.searchParams.get("config_id"), "ig-config-001");
  assert.equal(url.searchParams.get("redirect_uri"), env.META_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.has("scope"), false);
});

test("Facebook Pages use their own Business Login configuration ID", () => {
  const env = {
    META_APP_ID: "123456",
    META_APP_SECRET: "not-used-in-url",
    META_REDIRECT_URI: "https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback",
    META_FB_CONFIG_ID: "fb-config-002"
  };
  const url = new URL(buildMetaAuthorizationUrl(env, "state-value", "facebook"));
  assert.equal(url.searchParams.get("config_id"), "fb-config-002");
  assert.equal(url.searchParams.has("scope"), false);
});

test("Meta authorization refuses missing configuration IDs or app credentials", () => {
  assert.throws(() => buildMetaAuthorizationUrl({ META_APP_ID: "123" }, "state", "instagram"), /not configured/);
  assert.throws(() => buildMetaAuthorizationUrl({
    META_APP_ID: "123", META_APP_SECRET: "secret", META_REDIRECT_URI: "https://example.com/callback"
  }, "state", "facebook"), /not configured/);
});
