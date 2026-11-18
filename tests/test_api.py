import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
import openbot_server

client = TestClient(openbot_server.app)


def use_test_db(monkeypatch, tmp_path):
    monkeypatch.setattr(openbot_server, "DATABASE_PATH", tmp_path / "test.sqlite3")


def test_health_endpoint(monkeypatch, tmp_path):
    use_test_db(monkeypatch, tmp_path)
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "online"
    assert payload["version"] == openbot_server.APP_VERSION
    assert payload["stored_tasks"] == 0


def test_dispatch_requires_configured_provider_key(monkeypatch, tmp_path):
    use_test_db(monkeypatch, tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post(
        "/api/dispatch",
        json={
            "task_id": "TEST-001",
            "prompt": "ทดสอบระบบ",
            "bindings": {"master": {"provider": "openai", "model": "gpt-4o-mini", "systemPrompt": "test"}},
        },
    )
    assert response.status_code == 424
    assert "provider key" in response.text
    stored = client.get("/api/tasks/TEST-001")
    assert stored.status_code == 200
    assert stored.json()["status"] == "blocked"


def test_dispatch_returns_master_only_for_general_answer(monkeypatch, tmp_path):
    use_test_db(monkeypatch, tmp_path)

    async def fake_call_provider(binding, prompt, image_data=None, provider_keys=None):
        assert binding.model == "gpt-4o-mini"
        return "ตอบกลับจาก Master"

    monkeypatch.setattr(openbot_server, "call_provider", fake_call_provider)
    response = client.post(
        "/api/dispatch",
        json={
            "task_id": "TEST-002",
            "prompt": "ทดสอบ Master",
            "bindings": {"master": {"provider": "openai", "model": "gpt-4o-mini", "systemPrompt": "ตอบภาษาไทย"}},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["reply"] == "ตอบกลับจาก Master"
    assert payload["execution_mode"] == "master_only"
    assert payload["agents_used"] == []


def test_empty_master_plan_returns_summary_without_workers(monkeypatch, tmp_path):
    use_test_db(monkeypatch, tmp_path)

    async def fake_call_provider(binding, prompt, image_data=None, provider_keys=None):
        return json.dumps({"summary": "คำตอบจาก Master สำหรับคำถามทั่วไป", "tasks": []})

    monkeypatch.setattr(openbot_server, "call_provider", fake_call_provider)
    response = client.post(
        "/api/dispatch",
        json={"task_id": "TEST-EMPTY-PLAN", "prompt": "ถามคำถามทั่วไป"},
    )
    assert response.status_code == 200
    assert response.json()["reply"] == "คำตอบจาก Master สำหรับคำถามทั่วไป"
    assert response.json()["execution_mode"] == "master_only"


def test_dispatch_runs_master_plan_and_worker(monkeypatch, tmp_path):
    use_test_db(monkeypatch, tmp_path)
    calls = []

    async def fake_call_provider(binding, prompt, image_data=None, provider_keys=None):
        calls.append({"model": binding.model, "prompt": prompt, "keys": provider_keys or {}})
        if len(calls) == 1:
            return json.dumps({
                "summary": "มอบหมายงานให้ทีม Dev ตรวจสอบ",
                "tasks": [
                    {"agent_id": "prog1", "title": "วิเคราะห์ API", "instruction": "ตรวจโครงสร้าง API และเสนอแนวทาง"},
                    {"agent_id": "qa_bot", "title": "ออกแบบ Test", "instruction": "จัดทำ Test Case"},
                ],
            })
        if binding.model == "claude-worker":
            return "ผลวิเคราะห์ API"
        if binding.model == "qa-worker":
            return "Test Case: health endpoint"
        return "สรุปผลจากทีม Dev และ QA"

    monkeypatch.setattr(openbot_server, "call_provider", fake_call_provider)
    response = client.post(
        "/api/dispatch",
        json={
            "task_id": "TEST-MULTI-001",
            "prompt": "ตรวจสอบ API และออกแบบการทดสอบ",
            "bindings": {
                "master": {"provider": "openai", "model": "master-model", "systemPrompt": "master"},
                "prog1": {"provider": "anthropic", "model": "claude-worker", "systemPrompt": "dev"},
                "qa_bot": {"provider": "openai", "model": "qa-worker", "systemPrompt": "qa"},
            },
            "provider_keys": {"openai": "ephemeral-test-key"},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["execution_mode"] == "multi_agent"
    assert payload["agents_used"] == ["prog1", "qa_bot"]
    assert len(payload["results"]) == 2
    assert "สรุปผล" in payload["reply"]
    assert "ephemeral-test-key" not in response.text
    assert calls[1]["keys"]["openai"] == "ephemeral-test-key"
    stored = client.get("/api/tasks/TEST-MULTI-001").json()
    assert stored["status"] == "completed"
    assert len(stored["results"]) == 2
    assert "ephemeral-test-key" not in json.dumps(stored)


def test_parse_plan_rejects_unknown_and_duplicate_agents():
    parsed = openbot_server.parse_master_plan(json.dumps({
        "summary": "test",
        "tasks": [
            {"agent_id": "prog1", "instruction": "first"},
            {"agent_id": "prog1", "instruction": "duplicate"},
            {"agent_id": "unknown", "instruction": "not allowed"},
        ],
    }))
    assert parsed is not None
    assert [task["agent_id"] for task in parsed["tasks"]] == ["prog1"]


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
