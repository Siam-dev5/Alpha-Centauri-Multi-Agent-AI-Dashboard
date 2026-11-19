# Meta Unified Login and Webhooks

## Existing Meta app and selected login model

This integration targets the existing Meta app \`Alpha-Centauri\` in the \`Siam HRBP\` Business Portfolio. The Instagram use case selected in the Meta dashboard is **Manage messaging & content on Instagram** with **API setup with Unified Login**. Do not replace this with legacy Instagram Login or a classic Facebook OAuth request that sends explicit \`scope\` values.

The Worker uses separate Business Login configuration IDs:
- Instagram: Instagram API Unified Login configuration ID.
- Facebook Pages: Facebook Login for Business configuration ID for Page assets.

Each authorization URL sends \`client_id\`, \`config_id\`, \`redirect_uri\`, \`state\`, and \`response_type=code\`; it deliberately does not send a \`scope\` parameter. Permissions are defined by the saved Meta configuration.

## Cloudflare Worker

The Cloudflare Worker is the authoritative cloud Social & Commerce API:
- Worker: alpha-centauri-social-api
- Base URL: https://social-api.siamhrbp.com/api/social-commerce
- OAuth callback: https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback
- Webhook callback: https://social-api.siamhrbp.com/api/social-commerce/webhooks/meta

The Worker source of record for this change is \`cloudflare/worker.mjs\`. The deployed Worker is intentionally not changed by this PR.

## Required Worker secrets / vars

Set these on the Worker after the PR has been reviewed and approved. Never commit values:
- \`META_APP_ID\` (plain var; App ID is not secret)
- \`META_APP_SECRET\` (secret)
- \`META_IG_CONFIG_ID\` (plain var; Instagram API Unified Login configuration ID)
- \`META_FB_CONFIG_ID\` (plain var; Facebook Login for Business Page configuration ID)
- \`META_WEBHOOK_VERIFY_TOKEN\` (secret; generate a unique random value)
- \`META_REDIRECT_URI\` (plain var; exact callback URL above)
- \`META_GRAPH_API_VERSION\` (plain var; default v27.0)

Existing secrets remain:
- \`BOOTSTRAP_KEY\`
- \`TOKEN_ENCRYPTION_KEY\` (32-byte URL-safe base64 key)

## Meta permission configuration to preserve

Based on the existing Meta setup:
- Instagram Unified Login permissions selected: \`instagram_business_basic\`, \`instagram_business_content_publish\`, \`instagram_business_manage_comments\`, \`instagram_business_manage_insights\`, \`instagram_business_manage_messages\`.
- Facebook Page permissions selected: \`pages_manage_metadata\`, \`pages_manage_posts\`, \`pages_read_engagement\`, \`pages_read_user_content\`.
- \`pages_manage_engagement\` was previously identified as still needing to be added to the Page configuration if the intended comment/engagement actions require it.

Do not add unrelated advertising scopes such as \`ads_management\` or \`ads_read\` by default. Only add permissions that the actual feature set requires and that are approved in the selected Meta configuration.

## D1 migration

Apply \`migrations/0005_meta_webhooks.sql\` to the existing Worker D1 database before deploying the Worker source. It only creates the webhook event inbox and index; it does not alter existing rows or credentials. The existing D1 database already contains the \`oauth_states\` table used by this implementation.

## OAuth flow

1. Authenticated Social & Commerce user calls \`POST /oauth/meta/start\` with \`{"platform":"instagram"}\` or \`{"platform":"facebook"}\`.
2. Worker selects the corresponding configuration ID, creates a 10-minute one-time state value, stores only its SHA-256 hash, and returns the Meta Business Login authorization URL.
3. Meta redirects to the callback with code and state.
4. Worker verifies and consumes the state, exchanges the authorization code, and queries assigned assets using the selected login mode.
5. Instagram Unified Login discovers assigned Instagram accounts using \`/me/assigned_instagram_accounts\`. Facebook Page login discovers assigned Pages using \`/me/accounts\`.
6. Tokens are encrypted using the existing AES-GCM Worker key and stored server-side in D1. The code does not assume a short-lived user token or attempt the legacy long-lived-token exchange; system-user tokens configured with no expiration remain non-expiring in the account record.
7. The callback notifies the opener window by postMessage. Tokens are never returned to the browser.

The Business Login configuration must be set up for a system-user access token with the intended asset type and expiration. Instagram Unified Login requires the Instagram account to be assigned to the selected Business Portfolio and to the connecting person/configuration. If asset discovery returns no Instagram accounts, check the configuration's asset assignment and permissions; do not mark the connection successful.

## Webhook behavior

- GET verification requires \`hub.mode=subscribe\` and an exact \`hub.verify_token\` match; the endpoint returns \`hub.challenge\`.
- POST requires a valid \`X-Hub-Signature-256\` HMAC-SHA256 signature using \`META_APP_SECRET\`.
- Payloads over 1 MiB and invalid signatures/JSON are rejected.
- Verified payloads are stored in \`meta_webhook_events\` with a unique body hash for retry deduplication.
- The endpoint acknowledges verified notifications with HTTP 200.
- Instagram webhook fields are selected in the Meta App Dashboard. Page-level subscriptions are separately enabled with the Page access token and \`pages_manage_metadata\`. Instagram webhooks must be configured on the Instagram object in the App Dashboard; do not attempt to configure them through the Page subscribed_apps edge.

## Meta Developer dashboard values

- Valid OAuth Redirect URI: \`https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback\`
- Webhooks callback URL: \`https://social-api.siamhrbp.com/api/social-commerce/webhooks/meta\`
- Verify token: the exact value configured as \`META_WEBHOOK_VERIFY_TOKEN\` on the Worker.
- Use the same callback URI in both Business Login configurations.
- Subscribe the Page object to the needed Page fields in the App Dashboard.
- Subscribe the Instagram object and required fields in the App Dashboard.

## Current external prerequisites

The App ID, App Secret, Instagram Unified Login Configuration ID, and Facebook Page Configuration ID have not been supplied to the Worker. The Business Portfolio verification and App Review / Advanced Access status were not completed in the prior setup. This PR cannot create or approve those Meta settings or authenticate a real account. The owner must configure the Worker values and Meta dashboard settings after review. Until then, the health endpoint correctly reports each login configuration as not configured and publishing remains disabled.

## Security notes

- OAuth state is random, hashed at rest, expires after ten minutes, and is single-use.
- App secret and access tokens stay server-side.
- Graph API requests include Meta's appsecret_proof.
- Access tokens are encrypted at rest using AES-GCM.
- Webhook signatures are checked against the exact raw request body.
- Webhook payload deduplication is enforced by a unique SHA-256 hash.
- No automatic publishing was added.
