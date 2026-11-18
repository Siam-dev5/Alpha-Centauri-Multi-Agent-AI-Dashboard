import base64
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
import social_commerce as sc

app = FastAPI()
app.include_router(sc.router)
client = TestClient(app)


def use_db(monkeypatch, tmp_path):
    monkeypatch.setattr(sc, "DB_PATH", tmp_path / "social.sqlite3")


def test_health_reports_adapters_disabled(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    response = client.get("/api/social-commerce/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["publishing_enabled"] is False
    assert all(value == "not_configured" for value in payload["platform_adapters"].values())


def test_social_accounts_cannot_be_manually_marked_connected(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    response = client.post("/api/social-commerce/accounts", json={
        "platform": "facebook", "account_name": "Fake connected page"
    })
    assert response.status_code == 409


def test_affiliate_placeholder_stays_disconnected(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    response = client.post("/api/social-commerce/accounts", json={
        "platform": "shopee_affiliate", "account_name": "Affiliate publisher"
    })
    assert response.status_code == 201
    assert response.json()["status"] == "disconnected"
    assert client.get("/api/social-commerce/accounts").json()["accounts"][0]["status"] == "disconnected"


def test_content_requires_real_target_accounts(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    response = client.post("/api/social-commerce/content", json={
        "title":"Draft", "body":"Caption", "platforms":["facebook"], "account_ids":["not-real"]
    })
    assert response.status_code == 422


def test_approval_workflow_and_audit(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    account = client.post("/api/social-commerce/accounts", json={
        "platform":"shopee_affiliate", "account_name":"Publisher placeholder"
    }).json()
    item = client.post("/api/social-commerce/content", json={
        "title":"Product post", "body":"Caption with affiliate disclosure",
        "affiliate_url":"https://example.com/track", "disclosure":"ลิงก์ Affiliate",
        "platforms":["shopee_affiliate"], "account_ids":[account["id"]]
    })
    assert item.status_code == 201
    item_id = item.json()["id"]
    assert client.post(f"/api/social-commerce/content/{item_id}/submit").json()["status"] == "pending_approval"
    assert client.post(f"/api/social-commerce/content/{item_id}/decision", json={
        "decision":"approve", "actor":"owner"
    }).json()["status"] == "approved"
    assert client.get("/api/social-commerce/content").json()["items"][0]["status"] == "approved"
    assert len(client.get("/api/social-commerce/audit").json()["events"]) >= 3


def test_rejected_content_cannot_be_published_or_approved_twice(monkeypatch, tmp_path):
    use_db(monkeypatch, tmp_path)
    account = client.post("/api/social-commerce/accounts", json={
        "platform":"lazada_affiliate", "account_name":"Publisher placeholder"
    }).json()
    item_id = client.post("/api/social-commerce/content", json={
        "title":"Draft", "body":"Body", "platforms":["lazada_affiliate"],
        "account_ids":[account["id"]]
    }).json()["id"]
    client.post(f"/api/social-commerce/content/{item_id}/submit")
    assert client.post(f"/api/social-commerce/content/{item_id}/decision", json={
        "decision":"reject", "actor":"owner", "reason":"Needs edits"
    }).json()["status"] == "rejected"
    assert client.post(f"/api/social-commerce/content/{item_id}/decision", json={
        "decision":"approve", "actor":"owner"
    }).status_code == 409


def test_aes_gcm_token_encryption_round_trip(monkeypatch):
    key = base64.urlsafe_b64encode(os.urandom(32)).decode()
    monkeypatch.setenv("SOCIAL_TOKEN_ENCRYPTION_KEY", key)
    encrypted = sc.encrypt_token("sensitive-token")
    assert encrypted != "sensitive-token"
    assert sc.decrypt_token(encrypted) == "sensitive-token"
