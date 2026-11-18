import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
import openbot_server

client = TestClient(openbot_server.app)


def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "online"
    assert payload["version"] == openbot_server.APP_VERSION


def test_dispatch_requires_configured_provider_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post(
        "/api/dispatch",
        json={
            "task_id": "TEST-001",
            "prompt": "ทดสอบระบบ",
            "bindings": {
                "master": {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "systemPrompt": "test",
                }
            },
        },
    )
    assert response.status_code == 424
    assert "OPENAI_API_KEY" in response.text


def test_dispatch_returns_mocked_master_reply(monkeypatch):
    async def fake_call_provider(binding, prompt, image_data=None):
        assert binding.model == "gpt-4o-mini"
        assert prompt == "ทดสอบ Master"
        return "ตอบกลับจาก Master"

    monkeypatch.setattr(openbot_server, "call_provider", fake_call_provider)
    response = client.post(
        "/api/dispatch",
        json={
            "task_id": "TEST-002",
            "prompt": "ทดสอบ Master",
            "bindings": {
                "master": {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "systemPrompt": "ตอบภาษาไทย",
                }
            },
        },
    )
    assert response.status_code == 200
    assert response.json()["reply"] == "ตอบกลับจาก Master"
    assert response.json()["status"] == "completed"


def test_websocket_handshake():
    with client.websocket_connect("/ws") as websocket:
        payload = websocket.receive_json()
        assert payload["event"] == "GATEWAY_CONNECTED"


def test_pages_origin_private_network_preflight():
    response = client.options(
        "/api/dispatch",
        headers={
            "Origin": "https://siam-dev5.github.io",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://siam-dev5.github.io"
    assert response.headers["access-control-allow-private-network"] == "true"
