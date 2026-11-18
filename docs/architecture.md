# Alpha Centauri — Architecture and V1.1 Scope

## Target architecture

The product is designed as a Hybrid Local–Cloud Multi-Agent Command Center:

1. **Browser Dashboard:** text/image command input, 13-node interactive Star Map, per-agent provider/model/prompt configuration, activity log, task queue, and status visualization.
2. **OpenBot Local Gateway:** FastAPI HTTP dispatch and WebSocket event channel on the user's computer.
3. **Master Bot Orchestrator:** calls the configured Master LLM to create a bounded JSON task plan, validates agent IDs, dispatches specialist tasks in plan order, collects results, and asks Master to synthesize a final answer.
4. **Worker Nodes:** Dev, Media, and Admin specialist LLM bindings. Worker calls use each agent's configured provider/model/system prompt.
5. **Local Task Ledger:** SQLite persists task status, validated plans, and text results on the local computer. Images and provider API keys are deliberately excluded.
6. **Human approval boundary:** tasks involving publication, messages to external parties, production changes, or other consequential actions are limited to plans/recommendations. No worker has an external action tool in this release.

## Implemented in V1.1

- Supplied Dashboard HTML used as the visual baseline.
- 13 nodes remain in the supplied Star Map model.
- 18 character avatars from the supplied reference image, embedded as one optimized transparent WebP atlas and sliced in-browser.
- Unique character assignment in the browser UI.
- Fixed glassmorphism footer, LINE contact, print suppression, and bottom content padding.
- Local FastAPI gateway with /api/health, /api/dispatch, /api/tasks, /api/tasks/{task_id}, and /ws.
- Master planning prompt with strict JSON parsing and an allow-list of 10 Worker IDs.
- Sequential Worker execution and Master synthesis, with WebSocket transitions for each hand-off.
- OpenAI-compatible, xAI, Ollama-compatible, Gemini, and Anthropic provider adapters.
- Browser API credentials are forwarded only in a request to the configured localhost Gateway; environment variables are supported as fallback. Credentials are never written to SQLite or logs.
- SQLite task history stores prompt, plan, status, and text results locally. Image payloads and API keys are not stored.
- GitHub Pages deployment workflow and Python gateway CI.

## Not implemented yet

- Local filesystem read/write, terminal/shell execution, Git operations, FFmpeg rendering, image generation, YouTube upload, social publishing, or Cloudflare/production deployment tools.
- Persistent human-approval inbox or approval workflow for executing external actions.
- Distributed queue, parallel worker scheduling, retry policy, or multi-user authentication.
- Live provider billing/latency tests: CI uses mocked provider calls and does not require or consume API keys.

The Dashboard's Simulation Mode remains a UI simulation and is not evidence that external actions occurred. Live Gateway mode executes configured LLM calls only; workers cannot claim to have changed files, posted content, or deployed services.

## Security boundaries

- Keep .env local and never commit real provider keys.
- Bind the Gateway to 127.0.0.1 by default; do not expose it to the public internet.
- Restrict ALLOWED_ORIGINS to exact trusted Dashboard origins.
- The configured Dashboard sends provider credentials only to the localhost dispatch endpoint when OpenBot mode is enabled. They are request-scoped and not persisted by the Gateway.
- SQLite task history is local and includes user prompts and textual outputs; delete data/alpha_centauri.sqlite3 to remove local task history.
- Add filesystem, shell, deploy, and social-publishing tools only behind narrowly scoped permissions and Human Approval gates.
