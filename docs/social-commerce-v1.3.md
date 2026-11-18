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
- Meta: Facebook Pages and Instagram Professional publishing, subject to app configuration, account type, Page tasks, permissions and review.
- YouTube: OAuth 2.0 required for uploads and private channel data; API key alone is not sufficient.
- TikTok: Content Posting API with approved scopes and app audit. Unaudited clients are restricted to private visibility.
- Shopee and Lazada: treat Affiliate/Publisher APIs separately from Seller APIs. Verify Thailand eligibility, partner approval, scopes, link generation and report endpoints before enabling each adapter.
- If a platform does not grant an API capability, present a clearly labeled manual workflow rather than fabricating automation.

## Human approval policy
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
No social or marketplace account is connected by this commit. OAuth credentials, encryption key and platform approvals are external prerequisites. The foundation must not imply that publication or affiliate reporting is already live.
