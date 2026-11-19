# Meta OAuth and Webhooks

## Cloudflare Worker

The Cloudflare Worker is the authoritative cloud Social & Commerce API:
- Worker: alpha-centauri-social-api
- Base URL: https://social-api.siamhrbp.com/api/social-commerce
- OAuth callback: https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback
- Webhook callback: https://social-api.siamhrbp.com/api/social-commerce/webhooks/meta

The Worker source of record for this change is \`cloudflare/worker.mjs\`. The deployed Worker is intentionally not changed by this PR.

## Required Worker secrets / vars

Set these on the Worker after the PR has been reviewed and approved. Never commit values:
- \`META_APP_ID\` (secret or plain var; App ID is not secret)
- \`META_APP_SECRET\` (secret)
- \`META_WEBHOOK_VERIFY_TOKEN\` (secret; generate a unique random value)
- \`META_REDIRECT_URI\` (plain var; exact callback URL above)
- \`META_GRAPH_API_VERSION\` (plain var; default v27.0)
- \`META_OAUTH_SCOPES\` (plain var; comma-separated scopes; default is pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_metadata,instagram_basic,instagram_content_publish)

Existing secrets remain:
- \`BOOTSTRAP_KEY\`
- \`TOKEN_ENCRYPTION_KEY\` (32-byte URL-safe base64 key)

## D1 migration

Apply \`migrations/0005_meta_webhooks.sql\` to the existing Worker D1 database before deploying the Worker source. It only creates the webhook event inbox and index; it does not alter existing rows or credentials.

## OAuth flow

1. Authenticated Social & Commerce user calls \`POST /oauth/meta/start\`.
2. Worker creates a 10-minute one-time state value, stores only its SHA-256 hash, and returns the Meta authorization URL.
3. Meta redirects to the callback with code and state.
4. Worker verifies and consumes the state, exchanges the code, exchanges the short-lived token for a long-lived token, reads the user's Facebook Pages and linked Instagram Professional accounts, and stores Page tokens encrypted using the existing AES-GCM Worker key.
5. The callback notifies the opener window by postMessage. Tokens are never returned to the browser.

## Webhook behavior

- GET verification requires \`hub.mode=subscribe\` and an exact \`hub.verify_token\` match; the endpoint returns \`hub.challenge\`.
- POST requires a valid \`X-Hub-Signature-256\` HMAC-SHA256 signature using \`META_APP_SECRET\`.
- Payloads over 1 MiB and invalid signatures/JSON are rejected.
- Verified payloads are stored in \`meta_webhook_events\` with a unique body hash for retry deduplication.
- The endpoint acknowledges verified notifications with HTTP 200.
- Instagram webhook fields are selected in the Meta App Dashboard; Page-level subscriptions are separately enabled with the Page access token and \`pages_manage_metadata\`. See official Meta docs.

## Meta Developer dashboard values

- Valid OAuth Redirect URI: \`https://social-api.siamhrbp.com/api/social-commerce/oauth/meta/callback\`
- Webhooks callback URL: \`https://social-api.siamhrbp.com/api/social-commerce/webhooks/meta\`
- Verify token: the exact value configured as \`META_WEBHOOK_VERIFY_TOKEN\` on the Worker.
- Subscribe the Page object to the needed Page fields in the App Dashboard.
- Subscribe the Instagram object and required fields in the App Dashboard. Instagram webhooks are not configured through the Page subscribed_apps edge.

## Current external prerequisites

This PR cannot create or approve the Meta Developer App, grant App Review permissions, or authenticate a real Page/Instagram account. The owner must configure the Worker secrets and Meta dashboard values after review. Until then, the health endpoint correctly reports Meta OAuth as not configured and publishing remains disabled.

## Security notes

- OAuth state is random, hashed at rest, expires after ten minutes, and is single-use.
- App secret and access tokens stay server-side.
- Access tokens are encrypted at rest using AES-GCM.
- Webhook signatures are checked against the exact raw request body.
- Webhook payload deduplication is enforced by a unique SHA-256 hash.
- No automatic publishing was added.
