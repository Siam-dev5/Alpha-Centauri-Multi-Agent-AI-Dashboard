import sqlite3
from pathlib import Path


def test_meta_webhook_migration_creates_only_event_inbox_objects():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "0005_meta_webhooks.sql"
    db = sqlite3.connect(":memory:")
    db.executescript(migration.read_text(encoding="utf-8"))

    table = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='meta_webhook_events'"
    ).fetchone()
    assert table is not None
    assert "event_hash TEXT NOT NULL UNIQUE" in table[0]

    index = db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_meta_webhook_received'"
    ).fetchone()
    assert index is not None

    existing_tables = {
        row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert existing_tables == {"meta_webhook_events"}
