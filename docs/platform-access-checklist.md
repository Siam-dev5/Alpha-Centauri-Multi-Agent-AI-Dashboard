# External platform access checklist

This checklist identifies owner actions required before real integrations can be enabled. Never paste client secrets or access tokens into chat or commit them to Git.

## Meta — Facebook Pages / Instagram
- Create or select a Meta Developer App.
- Add Facebook Login / Instagram API products appropriate to the chosen account login model.
- Facebook Page publishing requires an eligible Page task and permissions such as pages_show_list, pages_read_engagement and pages_manage_posts.
- Instagram publishing requires a Professional Business or Creator account and the applicable Instagram publishing permission. Select Instagram Login or Facebook Login deliberately; they have different permission and account-linking models.
- Complete App Review / Business Verification where Meta requires it.
- Official docs: https://developers.facebook.com/docs/graph-api/reference/page/feed/
- Instagram API changelog and login model: https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/

## Google / YouTube
- Create/select a Google Cloud project and enable YouTube Data API v3.
- Configure OAuth consent screen and OAuth client.
- Uploads and private channel access require OAuth 2.0. The youtube.upload scope is relevant for uploads; an API key alone is insufficient.
- Official docs: https://developers.google.com/youtube/data/guides/authentication
- Upload endpoint: https://developers.google.com/youtube/v3/docs/videos/insert

## TikTok
### Account connection (Login Kit for Web) — implemented in the Cloud Worker
- In the TikTok for Developers app, add the **Login Kit** product with scope `user.info.basic`.
- Register this exact Web redirect URI (https, no query string):
  `https://social-api.siamhrbp.com/api/social-commerce/oauth/tiktok/callback`
- Store the app credentials only as Cloudflare Worker secrets:
  `wrangler secret put TIKTOK_CLIENT_KEY` and `wrangler secret put TIKTOK_CLIENT_SECRET`.
  Optional plain variables: `TIKTOK_REDIRECT_URI` (defaults to the URI above) and `TIKTOK_SCOPES` (defaults to `user.info.basic`).
- `GET /health` reports `platforms.tiktok = "oauth_ready"` once both secrets exist; the Dashboard then enables **เชื่อมต่อ TikTok · Login Kit**.
- Endpoints: `POST /oauth/tiktok/start`, `GET /oauth/tiktok/callback`, `POST /accounts/{id}/verify` (refreshes the 2-hour access token with the rotating refresh token and reads the live profile), `DELETE /accounts/{id}` (revokes the token).
- Tokens are AES-GCM encrypted at rest. No TikTok posting endpoint is called by this adapter.
- Docs: https://developers.tiktok.com/doc/login-kit-web, https://developers.tiktok.com/doc/oauth-user-access-token-management

### Publishing (not enabled)
- Create a TikTok for Developers app and add Content Posting API.
- Request and obtain approval for video.publish and obtain each creator's authorization.
- Complete the Content Posting API audit to remove private-only restrictions for unaudited clients.
- Official docs: https://developers.tiktok.com/docs/en/content-posting-api-get-started
- Direct Post: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post

## Shopee Affiliate Thailand
- Affiliate Open API access is subject to Shopee's review process; the Thai help page describes eligibility signals including more than 1,000 affiliate orders/month, a proper website or substantial social reach, and quality content.
- Seller Open API credentials are not interchangeable with Affiliate Open API access.
- Apply through the official Affiliate Open API process: https://help.shopee.co.th/portal/4/article/198622-%E0%B8%82%E0%B8%B1%E0%B9%89%E0%B8%99%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%82%E0%B8%AD%E0%B9%80%E0%B8%9B%E0%B8%B4%E0%B8%94-Affiliate-Open-API
- Do not enable API reporting until approval and current endpoint documentation are confirmed.

### Account connection (read-only) — implemented in the Cloud Worker
- After approval, copy **AppID** and **Secret** from affiliate.shopee.co.th > เปิด API > API ของฉัน.
- Store them only as Cloudflare Worker secrets: `wrangler secret put SHOPEE_AFFILIATE_APP_ID` and `wrangler secret put SHOPEE_AFFILIATE_SECRET`.
  Optional plain variable `SHOPEE_AFFILIATE_ENDPOINT` (default `https://open-api.affiliate.shopee.co.th/graphql`; only `open-api.affiliate.shopee.*` hosts are accepted).
- `GET /health` reports `platforms.shopee_affiliate = "api_ready"` once both secrets exist (`"awaiting_api_approval"` before); the Dashboard then enables **เชื่อมต่อ Shopee Affiliate · Open API**.
- Endpoints: `POST /affiliate/shopee/connect` (one signed read-only `shopeeOfferV2(limit:1)` query, then saves the account), `POST /accounts/{id}/verify` (repeats the live check), `DELETE /accounts/{id}`.
- Signing per Shopee docs: `Authorization: SHA256 Credential={AppId}, Timestamp={unix}, Signature=sha256(AppId+Timestamp+Payload+Secret)`; timestamp must be within 10 minutes of Shopee's clock.
- No short links, conversion reports, orders, listings or other transactions are called by this adapter. The secret is never stored in D1 or logs.

## Shopee Seller (ร้านค้าของผู้ใช้) — separate module, read-only
- Separate from the Affiliate adapter: code in `cloudflare/shopee_seller.mjs`, data in table `shopee_shops` (`migrations/0009_shopee_seller_shops.sql`, additive). Dashboard tab **ร้านค้า Shopee**.
- Scope: authorize a shop, exchange/refresh tokens, read `v2.shop.get_shop_info` (name, region, status, authorization expiry). An allow-list blocks every other Shopee path (products, orders, logistics, payments) before a request is made.
- Prerequisites (the seller must do these; no shortcut):
  1. Register a developer account at https://open.shopee.com (separate email login from Seller Centre).
  2. Create an app for your own shop (Seller In House System type) and set the Live Redirect URL Domain to `social-api.siamhrbp.com`.
  3. Put the Live credentials only into Worker secrets: `wrangler secret put SHOPEE_PARTNER_ID`, `wrangler secret put SHOPEE_PARTNER_KEY` (optional `SHOPEE_SELLER_ENV=sandbox`, `SHOPEE_SELLER_REDIRECT_URI`).
  4. Apply migration 0009 to D1 (needs a Cloudflare token with D1 edit permission).
  5. Seller authorization: the shop account logs in on Shopee, enters the SMS OTP and confirms (validity up to 365 days). Main accounts are not supported yet; sub-accounts cannot authorize.
- Redirect URI: `https://social-api.siamhrbp.com/api/social-commerce/oauth/shopee-seller/callback`
- Endpoints: `POST /oauth/shopee-seller/start`, `GET /oauth/shopee-seller/callback`, `GET /shopee-seller/shops`, `POST /shopee-seller/shops/{id}/verify`, `DELETE /shopee-seller/shops/{id}`. `/health` → `shopee_seller {configured, schema_ready, environment, mode:"read_only"}`.
- Signing: HMAC-SHA256(partner_key, partner_id+path+timestamp[+access_token+shop_id]), timestamp valid 5 minutes. access_token 4 h; refresh_token 30 days and single-use (rotated pair stored at once). Tokens AES-GCM encrypted at rest.
- Docs: https://open.shopee.com/developer-guide/20, https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1

## Lazada Affiliate
- Confirm the current Thailand Affiliate/Publisher API program and account eligibility with Lazada's official affiliate partner portal. A Lazada Open Platform community answer states that Affiliate API onboarding is guided through the Lazada Affiliate platform, rather than by creating a normal Seller Open Platform app; confirm this directly with partner support before implementation.
- Lazada Open Platform Seller APIs are intended for professional sellers managing their stores and are not proof of Affiliate API access.
- Do not substitute Seller Center credentials or invent affiliate endpoints.
- Enable link generation and reporting only after official affiliate access is granted and tested.
- Official starting points: https://open.lazada.com/ and https://open.lazada.com/apps/doc/doc?docId=108130&nodeId=10535

## Commercial content disclosure\n- TikTok requires creators to turn on its Commercial Content Disclosure setting when promoting a brand, product or service, including content with financial incentives. The application must include a human checklist/confirmation for this platform requirement; a caption disclosure alone must not be treated as a substitute for the TikTok setting.\n- Official guidance: https://ads.tiktok.com/resources/help/article/about-the-content-disclosure-setting-for-creators?lang=en-GB\n\n## Secret handling
- Store credentials in the local machine's .env or a secrets manager.
- Use a unique encryption key for token-at-rest encryption.
- Never upload .env, client secrets, refresh tokens or access tokens to GitHub or chat.
