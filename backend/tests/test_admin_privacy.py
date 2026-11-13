import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tafo.app import create_app
from tafo.config import Settings
from tafo.db import connect
from tafo.migrate import apply_migrations

from tests.conftest import add_task


def test_manager_access_is_deferred_and_role_headers_are_ignored(client):
    denied = client.get("/api/manager/tasks", headers={"X-Role": "manager"})
    assert denied.status_code == 501
    assert denied.json()["detail"]["code"] == "manager_access_deferred"
    personal = add_task(client, title="Personal sample", domain="personal")
    listed = client.get("/api/tasks", params={"view": "all", "role": "manager"}, headers={"X-Role": "manager"}).json()
    assert any(task["id"] == personal["id"] for task in listed["tasks"])
    assert listed["authorization"] == "none"
    missing = client.post("/api/calendar/blocks", json={"title": "nope"})
    assert missing.status_code in {404, 405}


def test_backup_roundtrip_and_agent_cannot_restore(client, settings):
    kept = add_task(client, title="Keep this sample")
    exported = client.get("/api/admin/export")
    assert exported.status_code == 200, exported.text
    snapshot = exported.json()
    assert snapshot["format"] == "tafo-backup"
    assert "Keep this sample" in json.dumps(snapshot["tables"]["tasks"])
    add_task(client, title="Drop this sample")
    saved = client.post("/api/admin/backup")
    assert saved.status_code == 200, saved.text
    path = settings.data_dir / "backups" / saved.json()["filename"]
    assert path.is_file()
    assert "worker@" not in path.read_text(encoding="utf-8")
    denied = client.post(
        "/api/admin/restore",
        headers={"X-TAFO-Actor": "agent"},
        json={"confirm": "REPLACE_LOCAL_DATA", "snapshot": snapshot},
    )
    assert denied.status_code == 403
    assert any(task["title"] == "Drop this sample" for task in client.get("/api/tasks").json()["tasks"])
    restored = client.post("/api/admin/restore", json={"confirm": "REPLACE_LOCAL_DATA", "snapshot": snapshot})
    assert restored.status_code == 200, restored.text
    titles = [task["title"] for task in client.get("/api/tasks").json()["tasks"]]
    assert titles == ["Keep this sample"]
    assert client.get(f"/api/tasks/{kept['id']}").status_code == 200
    rejected = client.post("/api/admin/restore", json={"confirm": "no", "snapshot": snapshot})
    assert rejected.status_code == 400


def test_migrations_apply_once(tmp_path):
    conn = connect(tmp_path / "migrated.sqlite")
    try:
        first = apply_migrations(conn)
        second = apply_migrations(conn)
        assert first == ["001_init", "002_indexes", "003_slice2"]
        assert second == []
        names = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert "idx_tasks_domain_status" in names
    finally:
        conn.close()


def test_seed_stays_fictional_and_simulated(tmp_path):
    settings = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=tmp_path / "seed.sqlite",
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=True,
    )
    with TestClient(create_app(settings)) as client:
        payload = client.get("/api/tasks", params={"view": "all", "scope": "all"}).json()
        domains = {task["domain"] for task in payload["tasks"]}
        assert domains == {"work", "home", "personal"}
        assert "@" not in json.dumps(payload)
        blocks = client.get("/api/calendar/blocks").json()["blocks"]
        assert blocks
        assert all(block["sync_state"] == "simulated" and block["google_event_id"] is None for block in blocks)
        assert all("not synced" in block["honest_label"].lower() for block in blocks)
        proposals = client.get("/api/hermes/proposals").json()["proposals"]
        assert any(item["status"] == "pending" and item["kind"] == "calendar_block" for item in proposals)
        meta = client.get("/api/meta").json()
        assert "not synced" in meta["sync_label"].lower()
        assert meta["manager_access"] == "deferred"


def test_env_example_has_empty_secret_placeholders(tmp_path):
    root = Path(__file__).resolve().parents[2]
    example = (root / ".env.example").read_text(encoding="utf-8")
    ignored = (root / ".gitignore").read_text(encoding="utf-8")
    assert ".env" in ignored
    assert "data/*" in ignored
    values = {}
    for line in example.splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    assert values["TAFO_GOOGLE_CREDENTIALS_FILE"] == ""
    assert values["TAFO_GOOGLE_CALENDAR_ID"] == ""
    assert values["TAFO_WORK_INVITE_EMAIL"] == ""
    assert values["TAFO_CALENDAR_MODE"] == "demo"
    assert "BEGIN PRIVATE" not in example
    spec_app = create_app(
        Settings(
            host="127.0.0.1",
            port=8787,
            data_dir=tmp_path,
            db_path=tmp_path / "openapi.sqlite",
            display_timezone="America/Indianapolis",
            calendar_mode="demo",
            google_credentials_file="",
            google_calendar_id="",
            work_invite_email="",
            allow_lan=False,
            seed_demo=False,
        )
    )
    with TestClient(spec_app) as client:
        paths = client.get("/openapi.json").json()["paths"]
    for path in (
        "/api/hermes/proposals",
        "/api/decisions/{proposal_id}/approve",
        "/api/calendar/outbox/{outbox_id}/retry",
        "/api/admin/export",
        "/api/admin/restore",
    ):
        assert path in paths


def test_non_loopback_bind_is_refused():
    settings = Settings(
        host="0.0.0.0",
        port=8787,
        data_dir=Path("."),
        db_path=Path("tafo.sqlite"),
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
    )
    with pytest.raises(RuntimeError, match="loopback"):
        settings.validate()
