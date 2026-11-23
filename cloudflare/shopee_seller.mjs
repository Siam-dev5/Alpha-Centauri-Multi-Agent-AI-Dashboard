// ---- Shopee Seller (shop owner) module: Shopee Open Platform v2. Separate from the Shopee Affiliate adapter. ----
// READ-ONLY by design: authorize a shop, exchange/refresh tokens, read the shop profile (v2.shop.get_shop_info).
// Every Shopee call goes through an allow-list; product, order, logistics, payment and any other write
// endpoint is refused before a request is made.
// Docs: open.shopee.com/developer-guide/20 (Authorization and Authentication), /documents/v2/v2.shop.get_shop_info
const HOSTS = {
  live: { auth: "https://open.shopee.com/auth", api: "https://partner.shopeemobile.com" },
  sandbox: { auth: "https://open.sandbox.test-stable.shopee.com/auth", api: "https://openplatform.sandbox.test-stable.shopee.sg" }
};
const DEFAULT_REDIRECT = "https://social-api.siamhrbp.com/api/social-commerce/oauth/shopee-seller/callback";
export const SHOPEE_SELLER_ALLOWED_PATHS = Object.freeze(["/api/v2/auth/token/get", "/api/v2/auth/access_token/get", "/api/v2/shop/get_shop_info"]);
export const SHOPEE_SELLER_STATE_PLATFORM = "shopee_seller";

export const shopeeSellerEnvironment = (env) => String(env.SHOPEE_SELLER_ENV || "live").trim() === "sandbox" ? "sandbox" : "live";
export const shopeeSellerConfigured = (env) => /^\d+$/.test(String(env.SHOPEE_PARTNER_ID || "").trim()) && !!String(env.SHOPEE_PARTNER_KEY || "").trim();
export const shopeeSellerRedirectUri = (env) => String(env.SHOPEE_SELLER_REDIRECT_URI || DEFAULT_REDIRECT).trim();

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
// sign = lowercase hex HMAC-SHA256(partner_key, base string)
export async function shopeeSellerSign(partnerKey, baseString) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(partnerKey)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(baseString))));
}

export function buildShopeeSellerAuthUrl(env, state) {
  if (!shopeeSellerConfigured(env)) throw new Error("Shopee Seller app is not configured");
  const url = new URL(HOSTS[shopeeSellerEnvironment(env)].auth);
  url.searchParams.set("partner_id", String(env.SHOPEE_PARTNER_ID).trim());
  url.searchParams.set("auth_type", "seller");
  url.searchParams.set("redirect_uri", shopeeSellerRedirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

// Signed call to an allow-listed path. Public (auth) APIs: partner_id+path+timestamp.
// Shop APIs: partner_id+path+timestamp+access_token+shop_id.
export async function shopeeSellerCall(env, path, { method = "GET", body = null, accessToken = null, shopId = null } = {}) {
  if (!SHOPEE_SELLER_ALLOWED_PATHS.includes(path)) throw new Error("Blocked Shopee Seller call (read-only module): " + path);
  if (!shopeeSellerConfigured(env)) throw new Error("Shopee Seller app is not configured");
  const partnerId = String(env.SHOPEE_PARTNER_ID).trim(), timestamp = Math.floor(Date.now() / 1000);
  const shopLevel = !!accessToken;
  const base = partnerId + path + timestamp + (shopLevel ? String(accessToken) + String(shopId) : "");
  const url = new URL(HOSTS[shopeeSellerEnvironment(env)].api + path);
  url.searchParams.set("partner_id", partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", await shopeeSellerSign(String(env.SHOPEE_PARTNER_KEY).trim(), base));
  if (shopLevel) { url.searchParams.set("access_token", String(accessToken)); url.searchParams.set("shop_id", String(shopId)); }
  const response = await fetch(url.toString(), { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (data.error) throw new Error("Shopee " + String(data.error).slice(0, 80) + ": " + String(data.message || "").slice(0, 160));
  if (!response.ok) throw new Error("Shopee request failed (HTTP " + response.status + ")");
  return data;
}

export async function shopeeSellerExchangeCode(env, code, shopId) {
  const data = await shopeeSellerCall(env, "/api/v2/auth/token/get", { method: "POST", body: { code: String(code), shop_id: Number(shopId), partner_id: Number(String(env.SHOPEE_PARTNER_ID).trim()) } });
  if (!data.access_token || !data.refresh_token) throw new Error("Shopee did not return tokens");
  return data;
}
export async function shopeeSellerRefresh(env, refreshToken, shopId) {
  const data = await shopeeSellerCall(env, "/api/v2/auth/access_token/get", { method: "POST", body: { refresh_token: String(refreshToken), shop_id: Number(shopId), partner_id: Number(String(env.SHOPEE_PARTNER_ID).trim()) } });
  if (!data.access_token || !data.refresh_token) throw new Error("Shopee did not return refreshed tokens");
  return data;
}
export const shopeeSellerShopInfo = (env, accessToken, shopId) => shopeeSellerCall(env, "/api/v2/shop/get_shop_info", { accessToken, shopId });

const iso = (unixSeconds) => Number(unixSeconds) > 0 ? new Date(Number(unixSeconds) * 1000).toISOString() : null;
const inSeconds = (s) => Number(s) > 0 ? new Date(Date.now() + Number(s) * 1000).toISOString() : null;
const REFRESH_TTL_SECONDS = 30 * 24 * 3600; // refresh_token is valid for 30 days per Shopee docs

// Routes. ctx supplies the Worker helpers (encrypt, decrypt, random, sha, now, audit, safeText, resultPage).
export function createShopeeSellerModule(ctx) {
  const { encrypt, decrypt, random, sha, now, audit, safeText, resultPage } = ctx;
  const page = (status, message) => resultPage("ALPHA_CENTAURI_SHOPEE_SELLER_OAUTH", "Shopee ร้านค้า", status, message);

  async function schemaReady(env) {
    try { return !!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopee_shops'").first(); }
    catch { return false; }
  }
  async function status(env) {
    return { configured: shopeeSellerConfigured(env), schema_ready: await schemaReady(env), environment: shopeeSellerEnvironment(env), redirect_uri: shopeeSellerRedirectUri(env), mode: "read_only" };
  }
  function shopView(row) {
    return { id: row.id, shop_id: row.shop_id, shop_name: row.shop_name, region: row.region, shop_status: row.shop_status, status: row.status, auth_expire_at: row.auth_expire_at, verified_at: row.verified_at, created_at: row.created_at, updated_at: row.updated_at };
  }
  async function saveShop(env, userId, shopId, info, token) {
    const stamp = now(), name = safeText(info.shop_name || "Shopee shop " + shopId, 160);
    await env.DB.prepare("INSERT INTO shopee_shops(id,owner_user_id,shop_id,shop_name,region,shop_status,status,auth_expire_at,token_expires_at,refresh_expires_at,encrypted_access_token,encrypted_refresh_token,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'connected',?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,shop_id) DO UPDATE SET shop_name=excluded.shop_name,region=excluded.region,shop_status=excluded.shop_status,status='connected',auth_expire_at=excluded.auth_expire_at,token_expires_at=excluded.token_expires_at,refresh_expires_at=excluded.refresh_expires_at,encrypted_access_token=excluded.encrypted_access_token,encrypted_refresh_token=excluded.encrypted_refresh_token,verified_at=excluded.verified_at,updated_at=excluded.updated_at")
      .bind(random(16), userId, String(shopId), name, safeText(info.region || "", 8) || null, safeText(info.status || "", 16) || null, iso(info.expire_time), inSeconds(token.expire_in), inSeconds(REFRESH_TTL_SECONDS), await encrypt(token.access_token, env), await encrypt(token.refresh_token, env), stamp, stamp, stamp).run();
    return name;
  }

  async function start(env, user) {
    if (!shopeeSellerConfigured(env)) return { status: 503, body: { error: "ยังไม่ได้ตั้งค่าแอป Shopee Open Platform บน Worker (SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY) — ต้องมี Seller authorization ก่อนเชื่อมร้านค้า" } };
    if (!await schemaReady(env)) return { status: 503, body: { error: "ฐานข้อมูลยังไม่มีตาราง shopee_shops (ต้อง apply migration 0009 ก่อนเชื่อมจริง)" } };
    const state = random(32), stamp = now(), expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<=?").bind(stamp).run();
    await env.DB.prepare("INSERT INTO oauth_states(state_hash,owner_user_id,platform,expires_at,created_at) VALUES(?,?,?,?,?)").bind(await sha(state), user.id, SHOPEE_SELLER_STATE_PLATFORM, expiry, stamp).run();
    return { status: 200, body: { authorization_url: buildShopeeSellerAuthUrl(env, state), expires_at: expiry, redirect_uri: shopeeSellerRedirectUri(env), environment: shopeeSellerEnvironment(env), mode: "read_only" } };
  }

  async function callback(env, url) {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code"), shopId = url.searchParams.get("shop_id");
    const stateHash = state ? await sha(state) : null;
    const stateRow = stateHash ? await env.DB.prepare("SELECT owner_user_id,expires_at FROM oauth_states WHERE state_hash=? AND platform=?").bind(stateHash, SHOPEE_SELLER_STATE_PLATFORM).first() : null;
    if (stateRow) await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=?").bind(stateHash).run();
    if (!stateRow || stateRow.expires_at <= now()) return page("error", "OAuth state is invalid or expired");
    if (!code) return page("error", "Shopee authorization was cancelled or no code was returned");
    if (url.searchParams.get("main_account_id") && !shopId) return page("error", "กรุณาอนุมัติด้วยบัญชีร้านค้า (shop account) — โมดูลนี้ยังไม่รองรับ main account");
    if (!/^\d+$/.test(String(shopId || ""))) return page("error", "Shopee did not return a valid shop_id");
    let stage = "token_exchange";
    try {
      if (!shopeeSellerConfigured(env)) throw new Error("Shopee Seller configuration is missing");
      const token = await shopeeSellerExchangeCode(env, code, shopId);
      stage = "shop_info";
      const info = await shopeeSellerShopInfo(env, token.access_token, shopId);
      stage = "persist_shop";
      const name = await saveShop(env, stateRow.owner_user_id, shopId, info, token);
      await audit(env, stateRow.owner_user_id, "shopee_seller_connected", "shopee_shop", String(shopId), "shopee-seller-callback", { shop_name: name, region: info.region || null, mode: "read_only" });
      return page("connected", "Shopee ร้านค้า: " + name);
    } catch (e) {
      const diagnostic = safeText(e?.message || "unknown Shopee Seller error", 300);
      console.error("shopee-seller-callback", { stage, message: diagnostic });
      try { await audit(env, stateRow.owner_user_id, "shopee_seller_connect_failed", "integration", "shopee_seller", "shopee-seller-callback", { stage, error: diagnostic }); } catch {}
      return page("error", "Shopee shop connection failed during " + stage + ". Diagnostic has been recorded for the system administrator.");
    }
  }

  async function list(env, user) {
    const st = await status(env);
    if (!st.schema_ready) return { status: 200, body: { shops: [], ...st } };
    const { results = [] } = await env.DB.prepare("SELECT * FROM shopee_shops WHERE owner_user_id=? ORDER BY shop_name").bind(user.id).all();
    return { status: 200, body: { shops: results.map(shopView), ...st } };
  }

  async function accessToken(env, shop) {
    if (shop.status !== "connected" || !shop.encrypted_access_token) throw new Error("Shopee shop is not connected");
    if (shop.token_expires_at && Date.parse(shop.token_expires_at) > Date.now() + 5 * 60000) return decrypt(shop.encrypted_access_token, env);
    let token;
    try { token = await shopeeSellerRefresh(env, await decrypt(shop.encrypted_refresh_token, env), shop.shop_id); }
    catch (e) { await env.DB.prepare("UPDATE shopee_shops SET status='expired',updated_at=? WHERE id=?").bind(now(), shop.id).run(); throw e; }
    // refresh_token is single-use: store the rotated pair immediately.
    await env.DB.prepare("UPDATE shopee_shops SET encrypted_access_token=?,encrypted_refresh_token=?,token_expires_at=?,refresh_expires_at=?,updated_at=? WHERE id=?")
      .bind(await encrypt(token.access_token, env), await encrypt(token.refresh_token, env), inSeconds(token.expire_in), inSeconds(REFRESH_TTL_SECONDS), now(), shop.id).run();
    return token.access_token;
  }

  async function verify(env, user, id) {
    if (!await schemaReady(env)) return { status: 404, body: { error: "Shopee shop not found" } };
    const shop = await env.DB.prepare("SELECT * FROM shopee_shops WHERE id=? AND owner_user_id=?").bind(id, user.id).first();
    if (!shop) return { status: 404, body: { error: "Shopee shop not found" } };
    try {
      const info = await shopeeSellerShopInfo(env, await accessToken(env, shop), shop.shop_id);
      const stamp = now();
      await env.DB.prepare("UPDATE shopee_shops SET shop_name=?,region=?,shop_status=?,auth_expire_at=?,verified_at=?,updated_at=? WHERE id=?")
        .bind(safeText(info.shop_name || shop.shop_name, 160), safeText(info.region || "", 8) || shop.region, safeText(info.status || "", 16) || shop.shop_status, iso(info.expire_time) || shop.auth_expire_at, stamp, stamp, shop.id).run();
      await audit(env, user.id, "shopee_seller_verified", "shopee_shop", shop.shop_id, user.email, { shop_status: info.status || null });
      return { status: 200, body: { id: shop.id, connected: true, shop_name: info.shop_name || shop.shop_name, shop_status: info.status || null, auth_expire_at: iso(info.expire_time), verified_at: stamp } };
    } catch (e) {
      const message = safeText(e?.message || "Shopee shop check failed", 240);
      await audit(env, user.id, "shopee_seller_verify_failed", "shopee_shop", shop.shop_id, user.email, { error: message });
      return { status: 502, body: { id: shop.id, connected: false, error: message } };
    }
  }

  async function disconnect(env, user, id) {
    if (!await schemaReady(env)) return { status: 404, body: { error: "Shopee shop not found" } };
    const shop = await env.DB.prepare("SELECT id,shop_id FROM shopee_shops WHERE id=? AND owner_user_id=?").bind(id, user.id).first();
    if (!shop) return { status: 404, body: { error: "Shopee shop not found" } };
    await env.DB.prepare("UPDATE shopee_shops SET status='disconnected',encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=? WHERE id=?").bind(now(), shop.id).run();
    await audit(env, user.id, "shopee_seller_disconnected", "shopee_shop", shop.shop_id, user.email, { note: "Tokens wiped locally; the seller can also cancel the authorization in Seller Centre" });
    return { status: 200, body: { id: shop.id, status: "disconnected" } };
  }

  return { status, start, callback, list, verify, disconnect };
}
