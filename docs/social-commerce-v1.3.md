# Social & Commerce Center — V1.3.0

## Product direction
Affiliate marketing is the active business model. The user promotes third-party products and earns affiliate commission. The platform must not treat affiliate catalog items as owned inventory or seller stock.

### Active scope
- Multi-account Social account registry: Facebook Pages, Instagram Professional, YouTube channels, TikTok.
- Affiliate workspace for Shopee and Lazada: product research, affiliate link records, campaign planning and performance imports where the official publisher API/account access permits.
- Content drafts, platform-specific copy/metadata, human approval, scheduling metadata, publication history and audit trail.
- Agent permissions are granted per connected account. Master Bot coordinates; specialist agents prepare research and creative work. Agents cannot publish without a human approval record.

### Deferred scope
- Own-brand product catalog, seller operations, order fulfillment and inventory.
- Future inventory policy: central shared stock or per-store stock selected by product/SKU. Affiliate products are never counted as owned stock.

## Architecture constraints
- Existing app is a static GitHub Pages dashboard plus a FastAPI Local Gateway and SQLite task ledger.
- Never put platform client secrets or OAuth tokens in index.html, browser storage, Git, or agent prompts.
- OAuth secrets and encryption keys stay in local environment configuration. Tokens must be encrypted at rest.
- Social actions run only through a dedicated backend adapter and require a user-approved content item.
- Do not expose the local gateway to the public internet by default.
- The static dashboard must display backend connection state honestly. No fake Connected status, sample affiliate earnings, clicks, conversions, or sales.
- Simulation mode is never a source of business analytics.

## Platform adapter strategy
- Meta Facebook Pages: image publishing is implemented through the Page Photos Graph API after Human Approval. Each Page must pass the live `pages_manage_posts` and `CREATE_CONTENT`/`MANAGE` task checks. Instagram Professional publishing remains deferred until its media-container/publish adapter and account-specific permissions are implemented.
- YouTube: OAuth 2.0 required for uploads and private channel data; API key alone is not sufficient.
- TikTok: Content Posting API with approved scopes and app audit. Unaudited clients are restricted to private visibility.
- Shopee and Lazada: treat Affiliate/Publisher APIs separately from Seller APIs. Verify Thailand eligibility, partner approval, scopes, link generation and report endpoints before enabling each adapter.
- If a platform does not grant an API capability, present a clearly labeled manual workflow rather than fabricating automation.

## Facebook Page publishing (first live adapter)\n- Upload a JPEG or PNG (maximum 8 MB) with an approved content item.\n- The Worker checks the content approval state, approved target account, stored Page access token, `pages_manage_posts`, and Page task `CREATE_CONTENT` or `MANAGE`.\n- Publish through `/{page-id}/photos` using the Page token; tokens never reach the browser.\n- Store the external Post ID and permalink in `publish_records` and the audit log.\n- Enforce one publication record per content/Page. If the network result is ambiguous, mark it `unknown` and block automatic retry to prevent duplicate public posts.\n\n## OpenBot chat command integration\n- An explicit Facebook publish command from the OpenBot chat is routed to the authenticated Social API in both Simulation and Live UI modes.\n- The command needs an authenticated Social & Commerce session and a connected Facebook Page that passes publish readiness. An attached JPEG/PNG makes a photo post (Page photos edge); without an image the text is published as a Page feed post. The caption may be quoted or follow the verb, e.g. `โพสต์ข้อความ "Hello Everyone" ไปยังเพจ Facebook` or `post Hello Everyone to Facebook page`. When several Pages are ready, the Page name must appear in the command.\n- The chat creates a draft and submits it for approval; it does not publish immediately.\n- The chat displays the exact Page, caption and image, then requires a separate user approval click and confirmation before calling the Facebook Page Photos API.\n- The chat reports only the API-confirmed Post ID/permalink; ambiguous outcomes are not retried automatically.\n\n## Human approval policy
1. Agent creates a draft or campaign proposal.
2. User reviews target accounts, media, caption, affiliate disclosure and links.
3. User approves the exact content and destinations.
4. Backend creates an auditable publish job with an idempotency key.
5. Connector publishes only to approved destinations and records platform response.
6. Failures remain visible and are retryable only with duplicate protection.

## Analytics integrity
- Clicks, attributed orders, approved commissions and canceled/refunded commissions are separate metrics.
- A click is not a sale. Pending commission is not approved income.
- Every metric records source platform, account, reporting period, retrieval time and raw-source reference where permitted.
- Missing API access is shown as unavailable, never zero.

## Release gates
- Phase A: backend foundation, encrypted token storage primitives, account registry, approval ledger, audit log and tests.
- Phase B: OAuth for Meta, Google/YouTube and TikTok after credentials are supplied.
- Phase C: affiliate API access review and integration for Shopee/Lazada after official partner approval.
- Phase D: account center and campaign/content UI, connected to the backend.
- Phase E: end-to-end testing with real accounts, then production release.

## Current limitation
Facebook Page image publishing is available only for OAuth-connected Pages that pass live permission and Page-task checks. Existing accounts with empty permission metadata must reconnect after the permission-discovery fix. Instagram, YouTube, TikTok, Shopee Affiliate and Lazada Affiliate publishing/reporting remain disabled until their separate adapters and official access reviews are completed. A successful CI run is not a real-account publication test.
