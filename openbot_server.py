"""Alpha Centauri local LLM gateway. Secrets remain in the local environment."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

APP_VERSION = "1.0.1"
DEFAULT_ORIGINS = (
    "http://localhost:5500,http://127.0.0.1:5500,"
    "http://localhost:8000,http://127.0.0.1:8000,https://siam-dev5.github.io"
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

app = FastAPI(title="Alpha Centauri Local Gateway", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization", "Access-Control-Request-Private-Network"],
)


class PrivateNetworkAccessHeaders(BaseHTTPMiddleware):
    """Allow explicitly-originated browser PNA preflights for the local gateway."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network", "").lower() == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response


app.add_middleware(PrivateNetworkAccessHeaders)


class Binding(BaseModel):
    provider: str = "openai"
    model: str = "gpt-4o-mini"
    systemPrompt: str = ""


class DispatchRequest(BaseModel):
    task_id: str = Field(default_factory=lambda: "AC-" + uuid.uuid4().hex[:8].upper())
    prompt: str = Field(min_length=1, max_length=20_000)
    image_base64: str | None = Field(default=None, max_length=12_000_000)
    bindings: dict[str, Binding] = Field(default_factory=dict)


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def emit(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for websocket in list(self.clients):
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.clients.discard(websocket)


hub = Hub()


def make_event(
    task_id: str, source: str, target: str, status: str, dept: str, message: str
) -> dict[str, str]:
    return {
        "event": "AGENT_TRANSITION",
        "task_id": task_id,
        "from_agent": source,
        "to_agent": target,
        "status": status,
        "dept": dept,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def call_provider(binding: Binding, prompt: str, image_data: str | None = None) -> str:
    provider = binding.provider.lower()
    model = binding.model
    env_names = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "xai": "XAI_API_KEY",
        "ollama": "OLLAMA_BASE_URL",
    }
    if provider not in env_names:
        raise HTTPException(400, f"Unsupported provider: {provider}")

    key = os.getenv(env_names[provider], "")
    if provider != "ollama" and not key:
        raise HTTPException(424, f"Missing local environment variable: {env_names[provider]}")

    if provider in ("openai", "xai", "ollama"):
        base_url = {
            "openai": "https://api.openai.com/v1",
            "xai": "https://api.x.ai/v1",
            "ollama": os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        }[provider]
        content: Any = prompt
        if image_data and provider != "ollama":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data}},
            ]
        headers = {"Authorization": f"Bearer {key}"} if provider != "ollama" else {}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": binding.systemPrompt or "Respond in Thai."},
                {"role": "user", "content": content},
            ],
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
        if response.is_error:
            raise HTTPException(502, f"{provider} API error {response.status_code}: {response.text[:500]}")
        return response.json()["choices"][0]["message"]["content"]

    if provider == "gemini":
        parts: list[dict[str, Any]] = [
            {"text": (binding.systemPrompt + "\n\n" if binding.systemPrompt else "") + prompt}
        ]
        if image_data and "," in image_data:
            metadata, encoded = image_data.split(",", 1)
            parts.append({"inline_data": {"mime_type": metadata[5:].split(";")[0], "data": encoded}})
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                params={"key": key},
                json={"contents": [{"parts": parts}]},
            )
        if response.is_error:
            raise HTTPException(502, f"Gemini API error {response.status_code}: {response.text[:500]}")
        return response.json()["candidates"][0]["content"]["parts"][0]["text"]

    content = [{"type": "text", "text": prompt}]
    if image_data and "," in image_data:
        metadata, encoded = image_data.split(",", 1)
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": metadata[5:].split(";")[0], "data": encoded},
        })
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
            json={
                "model": model,
                "max_tokens": 2048,
                "system": binding.systemPrompt or "You are Master Bot. Respond in Thai.",
                "messages": [{"role": "user", "content": content}],
            },
        )
    if response.is_error:
        raise HTTPException(502, f"Anthropic API error {response.status_code}: {response.text[:500]}")
    return "\n".join(item.get("text", "") for item in response.json().get("content", []))


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "service": "Alpha Centauri Local Gateway",
        "status": "online",
        "version": APP_VERSION,
        "websocket_clients": len(hub.clients),
        "allowed_origins": ALLOWED_ORIGINS,
    }


@app.post("/api/dispatch")
async def dispatch(request: DispatchRequest) -> dict[str, str]:
    master = request.bindings.get("master", Binding())
    await hub.emit(make_event(request.task_id, "user", "master", "WORKING", "CORE", "Master Bot กำลังประมวลผลคำสั่ง"))
    try:
        reply = await call_provider(master, request.prompt, request.image_base64)
        await hub.emit(make_event(request.task_id, "master", "user", "IDLE", "CORE", "Master Bot ส่งคำตอบกลับแล้ว"))
        return {
            "task_id": request.task_id,
            "status": "completed",
            "reply": reply,
            "provider": master.provider,
            "model": master.model,
        }
    except HTTPException as exc:
        await hub.emit(make_event(request.task_id, "master", "user", "BLOCKED", "CORE", str(exc.detail)))
        raise


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    hub.clients.add(websocket)
    try:
        await websocket.send_json({"event": "GATEWAY_CONNECTED", "message": "Connected to Alpha Centauri Local Gateway"})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.clients.discard(websocket)
    except Exception:
        hub.clients.discard(websocket)
