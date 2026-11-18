# Alpha Centauri Multi-Agent AI Dashboard — V1.0

Hybrid Local–Cloud dashboard based on the supplied HTML reference. Includes a 13-node Star Map UI, 18 character avatars, API configuration UI, local FastAPI gateway, HTTP dispatch, and WebSocket status events.

## Quick start (Windows PowerShell)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Add the provider key you intend to use to .env
uvicorn openbot_server:app --host 127.0.0.1 --port 8000 --reload
```

In another terminal, serve the dashboard:

```powershell
py -m http.server 5500
```

Open http://127.0.0.1:5500. Select Live API Mode, enable OpenBot, then use `http://127.0.0.1:8000/api/dispatch` and `ws://127.0.0.1:8000/ws`.

## Security

Keep API keys in the local `.env` file. Never commit secrets or expose the local gateway to the public internet. Set `ALLOWED_ORIGINS` to the exact dashboard origins you trust. Browser direct-provider mode stores keys in localStorage; Local Gateway mode is preferred.

## Current scope

V1.0 provides the dashboard foundation, 18 character assets, a local FastAPI gateway, provider adapters, and real-time WebSocket events. Full Master Bot task decomposition, worker tools, durable queue/state, approval workflows, and deployment integrations are planned for subsequent phases. Simulation is a UI demo and is not evidence that external actions occurred.

## Enable GitHub Pages (one-time owner action)

Open **Settings → Pages** for this repository and set **Build and deployment → Source** to **GitHub Actions**. This is a one-time repository setting. After it is enabled, pushes to `main` that change `index.html` or the Pages workflow deploy the static Dashboard automatically. Expected site URL: `https://siam-dev5.github.io/Alpha-Centauri-Multi-Agent-AI-Dashboard/`.
