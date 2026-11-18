# Alpha Centauri — Architecture and V1.3.0 Scope

## Core architecture
1. Browser Dashboard: command input, 13-node Star Map, 18 character avatars, provider/model configuration, activity log, and Social & Commerce workspace.
2. OpenBot Local Gateway: FastAPI HTTP and WebSocket service on the user's computer.
3. Master Bot Orchestrator: bounded planning, fixed Worker allow-list, sequential execution and synthesis.
4. Worker Nodes: Dev, Media and Admin specialist LLM bindings.
5. Local SQLite ledgers: task history and Social & Commerce account/content/audit records.
6. Human approval boundary: external publication remains blocked until a specific content item and destination have been approved.

## V1.3.0 Social & Commerce foundation
- Multi-platform account registry: Facebook, Instagram, YouTube, TikTok, Shopee Affiliate and Lazada Affiliate.
- Affiliate business model is active. Third-party affiliate items are not owned inventory.
- Content drafts with platform/account destinations, affiliate disclosure and approval/rejection.
- Audit events for account and content lifecycle.
- AES-256-GCM token encryption primitive. The encryption key is read from local environment configuration.
- The UI explicitly reports missing OAuth/API setup and does not fake connected accounts or publication success.

## Not yet enabled
- Meta, Google/YouTube and TikTok OAuth callback/exchange adapters.
- Shopee/Lazada Affiliate API link generation and reporting.
- Real content publishing, scheduling worker, retry queue and platform webhooks.
- Own-brand product catalog, seller orders and stock management. Future inventory may support central shared stock or per-store stock by SKU.
- Multi-user authentication and remote/cloud hosting for Social & Commerce.

## Security
- Keep secrets out of browser code, localStorage, Git and agent prompts.
- Bind the local Gateway to 127.0.0.1.
- Restrict CORS to exact trusted origins.
- Encrypt platform tokens at rest before adding token persistence.
- Use OAuth state/PKCE as supported by each provider, least-privilege scopes, explicit disconnect and audit logs.
- Add external actions only behind per-account authorization and Human Approval.

## Release gates
A real integration is complete only after credentials are provisioned, OAuth and refresh are tested, a real account is shown with verified identity, permissions are enforced, publishing responses are captured, and analytics are imported from official sources.
