# Alpha Centauri Multi-Agent AI Dashboard — V1.3.0

Hybrid Local–Cloud command dashboard with a 13-node Star Map, 18 character avatars, local FastAPI Gateway, Master/Worker LLM orchestration, WebSocket status transitions, and SQLite task history.

## Quick start (Windows PowerShell)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
# Configure provider API keys and a local SOCIAL_TOKEN_ENCRYPTION_KEY in .env
uvicorn openbot_server:app --host 127.0.0.1 --port 8000 --reload --env-file .env
```

In a second terminal:

```powershell
py -m http.server 5500
```

Open http://127.0.0.1:5500. Choose Live API Mode and configure the local Gateway at http://127.0.0.1:8000.

## Social & Commerce Center — V1.3.0 Foundation

The Dashboard now includes a Social & Affiliate workspace backed by local FastAPI endpoints:
- Social account registry for Facebook Pages, Instagram, YouTube and TikTok.
- Affiliate account placeholders for Shopee and Lazada (explicitly marked Disconnected until authorized).
- Content drafts, affiliate disclosure field, target account selection and human approval/rejection workflow.
- Audit events for account and content lifecycle changes.
- AES-256-GCM token encryption helper using a key held only in local environment configuration.

**Important:** This is the secure foundation, not a claim that platform accounts are already connected. Facebook Page photo publishing is implemented behind Human Approval and live `pages_manage_posts` / Page-task checks. Instagram, YouTube, TikTok and Affiliate publishing/reporting remain disabled until their separate adapters, developer credentials, permissions and required reviews are completed. The UI must not represent placeholder accounts as connected or show fabricated clicks, orders or commissions.

See [Social & Commerce architecture](docs/social-commerce-v1.3.md) and [platform access checklist](docs/platform-access-checklist.md).

## Live Multi-Agent execution

1. Master Bot analyses the request and returns a JSON plan.
2. The Gateway validates Worker IDs against the fixed 10-agent allow-list.
3. Selected Workers run in plan order using configured provider/model/system prompts.
4. Master synthesizes Worker outputs and returns the final response.
5. WebSocket events update Agent status and the Star Map while SQLite keeps local task history.

Provider API credentials are request-scoped or loaded from the local .env; they are not persisted in the task ledger.

## GitHub Pages

The static Dashboard is published at:
https://siam-dev5.github.io/Alpha-Centauri-Multi-Agent-AI-Dashboard/

The Local Gateway must be running on the user's computer for Social & Commerce and live multi-agent API functions. GitHub Pages does not host the local FastAPI service.

## Security and limitations

- Never commit .env, OAuth client secrets, access tokens, refresh tokens or encryption keys.
- Keep the Gateway bound to 127.0.0.1; do not expose it publicly.
- OAuth credentials and platform access reviews are required before real account connection.
- TikTok unaudited Content Posting API clients are restricted to private visibility.
- Shopee Affiliate Open API is subject to Thailand program eligibility and approval; Seller API credentials are not a substitute.
- Affiliate reporting must distinguish clicks, attributed orders, pending/approved commission and cancellations. Missing API data is unavailable, not zero.
- No publication occurs without an explicit human approval step.
- The Simulation Mode remains a visual demo, not a real execution record.

CI uses mocked provider calls and local tests; a passing workflow is not a live API or real-account publishing test.
