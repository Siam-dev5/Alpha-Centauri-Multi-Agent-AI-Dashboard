"""Local-only Social & Commerce foundation.

This module intentionally provides account metadata, content approvals and audit
records first. Platform OAuth/publishing adapters are enabled only after official
credentials and platform review are available. Secrets never belong in the browser.
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, HttpUrl

DB_PATH = Path(os.getenv("SOCIAL_COMMERCE_DB", "data/social_commerce.sqlite3"))
PLATFORMS = {"facebook", "instagram", "youtube", "tiktok", "shopee_affiliate", "lazada_affiliate"}
SOCIAL_PLATFORMS = {"facebook", "instagram", "youtube", "tiktok"}
CONTENT_STATUSES = {"draft", "pending_approval", "approved", "rejected", "scheduled", "published", "failed"}
router = APIRouter(prefix="/api/social-commerce", tags=["Social & Commerce"])


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_social_db() -> None:
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS social_accounts (
          id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_account_id TEXT,
          account_name TEXT NOT NULL, profile_picture_url TEXT,
          status TEXT NOT NULL DEFAULT 'disconnected',
          scopes_json TEXT NOT NULL DEFAULT '[]', token_expires_at TEXT,
          encrypted_access_token TEXT, encrypted_refresh_token TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(platform, external_account_id)
        );
        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
          affiliate_url TEXT, disclosure TEXT NOT NULL DEFAULT '',
          platforms_json TEXT NOT NULL, account_ids_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          approved_at TEXT, approved_by TEXT, rejection_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL, actor TEXT NOT NULL, details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_status ON content_items(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
        """)


def _audit(db: sqlite3.Connection, event_type: str, entity_type: str,
           entity_id: str, actor: str, details: dict[str, Any] | None = None) -> None:
    db.execute(
        "INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, event_type, entity_type, entity_id, actor,
         json.dumps(details or {}, ensure_ascii=False), now()),
    )


class AccountCreate(BaseModel):
    platform: str
    account_name: str = Field(min_length=1, max_length=160)
    external_account_id: str | None = Field(default=None, max_length=200)
    profile_picture_url: HttpUrl | None = None


class ContentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=20_000)
    affiliate_url: HttpUrl | None = None
    disclosure: str = Field(default="", max_length=1000)
    platforms: list[str] = Field(min_length=1, max_length=6)
    account_ids: list[str] = Field(min_length=1, max_length=30)


class ApprovalDecision(BaseModel):
    decision: str
    actor: str = Field(min_length=1, max_length=120)
    reason: str = Field(default="", max_length=1000)


@router.get("/health")
def social_health() -> dict[str, Any]:
    init_social_db()
    with connect() as db:
        accounts = db.execute("SELECT COUNT(*) FROM social_accounts").fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM content_items WHERE status='pending_approval'").fetchone()[0]
    return {
        "service": "Social & Commerce Local Foundation",
        "status": "online",
        "mode": "local_foundation",
        "connected_accounts": accounts,
        "pending_approvals": pending,
        "platform_adapters": {name: "not_configured" for name in sorted(PLATFORMS)},
        "publishing_enabled": False,
    }


@router.get("/accounts")
def list_accounts() -> dict[str, Any]:
    init_social_db()
    with connect() as db:
        rows = db.execute("""SELECT id,platform,external_account_id,account_name,
          profile_picture_url,status,scopes_json,token_expires_at,created_at,updated_at
          FROM social_accounts ORDER BY platform,account_name""").fetchall()
    return {"accounts": [{**dict(row), "scopes": json.loads(row["scopes_json"])} for row in rows]}


@router.post("/accounts", status_code=201)
def create_account(payload: AccountCreate) -> dict[str, Any]:
    init_social_db()
    if payload.platform not in PLATFORMS:
        raise HTTPException(422, "Unsupported platform")
    if payload.platform in SOCIAL_PLATFORMS:
        raise HTTPException(409, "Social accounts must be connected through OAuth; manual connected-account creation is disabled")
    account_id = uuid.uuid4().hex
    stamp = now()
    try:
        with connect() as db:
            db.execute("""INSERT INTO social_accounts
              (id,platform,external_account_id,account_name,profile_picture_url,status,created_at,updated_at)
              VALUES (?,?,?,?,?,'disconnected',?,?)""",
              (account_id,payload.platform,payload.external_account_id,payload.account_name,
               str(payload.profile_picture_url) if payload.profile_picture_url else None,stamp,stamp))
            _audit(db,"account_placeholder_created","account",account_id,"local_user",{"platform":payload.platform})
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "This platform account already exists") from exc
    return {"id": account_id, "status": "disconnected", "message": "Account placeholder created; no platform authorization is present."}


@router.delete("/accounts/{account_id}")
def disconnect_account(account_id: str) -> dict[str, str]:
    init_social_db()
    with connect() as db:
        row = db.execute("SELECT id,platform FROM social_accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Account not found")
        db.execute("""UPDATE social_accounts SET status='disconnected',
          encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=? WHERE id=?""",
          (now(),account_id))
        _audit(db,"account_disconnected","account",account_id,"local_user",{"platform":row["platform"]})
    return {"id": account_id, "status": "disconnected"}


@router.get("/content")
def list_content(status: str | None = None) -> dict[str, Any]:
    init_social_db()
    if status and status not in CONTENT_STATUSES:
        raise HTTPException(422, "Invalid content status")
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM content_items WHERE status=? ORDER BY updated_at DESC" if status
            else "SELECT * FROM content_items ORDER BY updated_at DESC",
            (status,) if status else (),
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["platforms"] = json.loads(item.pop("platforms_json"))
        item["account_ids"] = json.loads(item.pop("account_ids_json"))
        result.append(item)
    return {"items": result}


@router.post("/content", status_code=201)
def create_content(payload: ContentCreate) -> dict[str, Any]:
    init_social_db()
    if any(platform not in PLATFORMS for platform in payload.platforms):
        raise HTTPException(422, "Unsupported target platform")
    if len(set(payload.platforms)) != len(payload.platforms) or len(set(payload.account_ids)) != len(payload.account_ids):
        raise HTTPException(422, "Duplicate platforms or account destinations are not allowed")
    item_id, stamp = uuid.uuid4().hex, now()
    with connect() as db:
        existing = db.execute(
            f"SELECT id,platform,status FROM social_accounts WHERE id IN ({','.join('?' for _ in payload.account_ids)})",
            payload.account_ids,
        ).fetchall()
        if len(existing) != len(payload.account_ids):
            raise HTTPException(422, "One or more target accounts do not exist")
        if {row["platform"] for row in existing} - set(payload.platforms):
            raise HTTPException(422, "Every target account platform must be selected")
        db.execute("""INSERT INTO content_items
          (id,title,body,affiliate_url,disclosure,platforms_json,account_ids_json,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'draft',?,?)""",
          (item_id,payload.title,payload.body,str(payload.affiliate_url) if payload.affiliate_url else None,
           payload.disclosure,json.dumps(payload.platforms),json.dumps(payload.account_ids),stamp,stamp))
        _audit(db,"content_draft_created","content",item_id,"local_user",{"platforms":payload.platforms})
    return {"id":item_id,"status":"draft","message":"Draft saved. No publication has occurred."}


@router.post("/content/{item_id}/submit")
def submit_for_approval(item_id: str) -> dict[str, str]:
    init_social_db()
    with connect() as db:
        row = db.execute("SELECT status FROM content_items WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Content item not found")
        if row["status"] not in {"draft", "rejected"}:
            raise HTTPException(409, "Only draft or rejected content can be submitted")
        db.execute("UPDATE content_items SET status='pending_approval',updated_at=? WHERE id=?", (now(),item_id))
        _audit(db,"content_submitted_for_approval","content",item_id,"local_user")
    return {"id":item_id,"status":"pending_approval"}


@router.post("/content/{item_id}/decision")
def decide_content(item_id: str, payload: ApprovalDecision) -> dict[str, str]:
    init_social_db()
    if payload.decision not in {"approve", "reject"}:
        raise HTTPException(422, "Decision must be approve or reject")
    with connect() as db:
        row = db.execute("SELECT status FROM content_items WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Content item not found")
        if row["status"] != "pending_approval":
            raise HTTPException(409, "Content item is not awaiting approval")
        status = "approved" if payload.decision == "approve" else "rejected"
        db.execute("""UPDATE content_items SET status=?,updated_at=?,approved_at=?,
          approved_by=?,rejection_reason=? WHERE id=?""",
          (status,now(),now() if status == "approved" else None,
           payload.actor if status == "approved" else None,
           payload.reason if status == "rejected" else None,item_id))
        _audit(db,f"content_{payload.decision}d","content",item_id,payload.actor,{"reason":payload.reason})
    return {"id":item_id,"status":status}


@router.get("/audit")
def list_audit(limit: int = 100) -> dict[str, Any]:
    init_social_db()
    with connect() as db:
        rows = db.execute("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", (max(1,min(limit,500)),)).fetchall()
    return {"events":[{**dict(row),"details":json.loads(row["details_json"])} for row in rows]}


def encrypt_token(token: str) -> str:
    """Encrypt a token using AES-GCM; key must be a base64-encoded 32-byte value."""
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw_key = os.getenv("SOCIAL_TOKEN_ENCRYPTION_KEY", "")
    try:
        key = base64.urlsafe_b64decode(raw_key.encode())
    except Exception as exc:
        raise RuntimeError("SOCIAL_TOKEN_ENCRYPTION_KEY must be URL-safe base64 for 32 random bytes") from exc
    if len(key) != 32:
        raise RuntimeError("SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, token.encode(), b"alpha-centauri-social-token-v1")
    return base64.urlsafe_b64encode(nonce + ciphertext).decode()


def decrypt_token(encrypted: str) -> str:
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = base64.urlsafe_b64decode(os.getenv("SOCIAL_TOKEN_ENCRYPTION_KEY", "").encode())
    if len(key) != 32:
        raise RuntimeError("SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
    payload = base64.urlsafe_b64decode(encrypted.encode())
    return AESGCM(key).decrypt(payload[:12], payload[12:], b"alpha-centauri-social-token-v1").decode()
