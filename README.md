# Alpha Centauri Multi-Agent AI Dashboard — V1.1

Hybrid Local–Cloud command dashboard based on the supplied HTML reference. Includes a 13-node Star Map, 18 Ragnarok-style character avatars, API configuration, a local FastAPI Gateway, a Master planning stage, specialist LLM Workers, WebSocket transitions, and a local SQLite task history.

## Quick start (Windows PowerShell)

~~~powershell
py -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
# Enter provider keys in Dashboard > API & System Config, or in local .env
uvicorn openbot_server:app --host 127.0.0.1 --port 8000 --reload --env-file .env
~~~

In a second terminal:

~~~powershell
py -m http.server 5500
~~~

Open http://127.0.0.1:5500. Choose **Live API Mode**, enable OpenBot, and use http://127.0.0.1:8000/api/dispatch plus ws://127.0.0.1:8000/ws.

## Live Multi-Agent execution

1. Master Bot analyses the request and returns a JSON plan.
2. The Gateway validates Worker IDs against the fixed 10-agent allow-list.
3. Selected Workers run in plan order using their configured provider/model/system prompt.
4. Master synthesizes Worker outputs and returns the final response.
5. WebSocket events update Agent status and the Star Map while SQLite keeps local task history.

When OpenBot is enabled, provider API credentials from the Dashboard are sent only to the localhost Gateway for that request. The Gateway does not write credentials or image payloads to SQLite or logs. A local .env file can be used as a fallback.

## Enable GitHub Pages (one-time owner action)

Open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The deployment workflow will then publish the static Dashboard. Expected site URL:

https://siam-dev5.github.io/Alpha-Centauri-Multi-Agent-AI-Dashboard/

## Local task history

The Gateway stores task prompts, plans, statuses, and text results in data/alpha_centauri.sqlite3. Image payloads and provider API keys are not stored. Delete this file to clear local history.

## Current scope and limitations

This release runs real Master and Worker LLM calls. It does **not** yet read/write local project files, run terminal commands, execute Git operations, render videos, generate images, publish to social media, or deploy production services. Those actions require dedicated tools and explicit Human Approval gates. The Simulation Mode remains a visual demo, not a real execution record.

CI compiles Python and runs mocked Gateway tests. CI does not make paid provider calls; a passing test is not a live API billing or provider-availability test.
