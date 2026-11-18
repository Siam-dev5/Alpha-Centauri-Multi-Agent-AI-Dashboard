# Alpha Centauri — Architecture and V1.0 Scope

## Target architecture

The product is designed as a Hybrid Local–Cloud Multi-Agent Command Center:

1. Browser Dashboard: text/image command input, 13-node interactive Star Map, per-agent provider/model/prompt configuration, activity log, task queue, and status visualization.
2. OpenBot Local Gateway: FastAPI HTTP dispatch and WebSocket event channel on the user's computer.
3. Orchestrator: Master Bot decomposes tasks into specialist work, tracks state, and coordinates Dev, Media, and Admin teams.
4. Worker tools: local filesystem/shell and QA tools for Dev; image/video tools for Media; approved admin/social integrations for Admin.
5. Human approval: explicit approval gates for consequential external actions, publication, and production deployment.

## Implemented in this V1.0 foundation

- Supplied dashboard HTML used as the visual baseline.
- 13 nodes remain in the supplied Star Map model.
- 18 character avatars from the supplied character reference image, embedded as one optimized transparent WebP atlas and sliced in-browser into 18 selectable avatars.
- Unique character assignment in the browser UI.
- Fixed glassmorphism footer, LINE contact, print suppression, and bottom content padding.
- Local FastAPI gateway with `/api/health`, `/api/dispatch`, and `/ws`.
- Provider adapters for OpenAI-compatible, xAI, Ollama-compatible, Gemini, and Anthropic APIs.
- Provider credentials are read from local environment variables; no keys are included in the repository.
- GitHub Pages workflow for static Dashboard delivery.

## Explicitly not complete yet

This foundation dispatches a live request to the configured Master model. It does not yet implement full multi-agent task decomposition, specialist worker execution, durable task queue/state, human-approval persistence, filesystem/shell tools, or external publication/deploy integrations. The dashboard's Simulation Mode remains a UI simulation and is not evidence of real external actions.

## Security boundaries

- Keep `.env` local and never commit secrets.
- Bind the gateway to localhost by default.
- Restrict `ALLOWED_ORIGINS` to exact trusted dashboard origins.
- Expose local filesystem, shell, deploy, and social publishing tools only through scoped permissions and approval gates in later phases.
