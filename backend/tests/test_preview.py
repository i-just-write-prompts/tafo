"""Preview mode is demo-only, password-gated, and reloads the Slice 1 fixture on startup."""

import base64
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tafo.app import create_app
from tafo.config import Settings
from tafo.preview import reseed_preview

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = "preview-secret"


def preview_settings(tmp_path: Path, **overrides) -> Settings:
    db_path = tmp_path / "tafo.sqlite"
    fields = dict(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=db_path,
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
        preview=True,
        preview_password=PASSWORD,
    )
    fields.update(overrides)
    return Settings(**fields)


def basic(password: str, username: str = "ignored") -> dict[str, str]:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def test_preview_env_drops_google_and_stays_in_demo(monkeypatch):
    monkeypatch.setenv("TAFO_PREVIEW", "1")
    monkeypatch.setenv("TAFO_CALENDAR_MODE", "live")
    monkeypatch.setenv("TAFO_GOOGLE_CREDENTIALS_FILE", "/tmp/secret.json")
    monkeypatch.setenv("TAFO_GOOGLE_CALENDAR_ID", "primary")
    monkeypatch.setenv("TAFO_WORK_INVITE_EMAIL", "person@example.com")
    monkeypatch.setenv("TAFO_SEED_DEMO", "1")
    monkeypatch.setenv("TAFO_DB_PATH", "")
    monkeypatch.setenv("TAFO_DATA_DIR", "")
    settings = Settings.from_env()
    assert settings.preview is True
    assert settings.calendar_mode == "demo"
    assert settings.google_credentials_file == ""
    assert settings.google_calendar_id == ""
    assert settings.work_invite_email == ""
    assert settings.seed_demo is False
    assert settings.preview_password == ""
    assert settings.db_path.name == "tafo.sqlite"
    assert "tafo-preview" in str(settings.db_path)
    assert not str(settings.db_path).endswith("data/tafo.sqlite")


def test_preview_refuses_the_default_database(monkeypatch, tmp_path):
    monkeypatch.chdir(ROOT)
    default = ROOT / "data" / "tafo.sqlite"
    before = default.read_bytes() if default.exists() else None
    settings = preview_settings(tmp_path, data_dir=ROOT / "data", db_path=default)
    with pytest.raises(Exception, match="data/tafo.sqlite"):
        reseed_preview(settings)
    after = default.read_bytes() if default.exists() else None
    assert before == after


def test_preview_reloads_the_slice1_fixture(tmp_path):
    settings = preview_settings(tmp_path)
    reseed_preview(settings)
    conn = sqlite3.connect(settings.db_path)
    try:
        conn.execute("DELETE FROM tasks")
        conn.commit()
    finally:
        conn.close()
    reseed_preview(settings)
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    try:
        titles = {row["title"] for row in conn.execute("SELECT title FROM tasks")}
        assert "Plan Saturday hike route" in titles
        assert "Hold the ladder" in titles
        assert "Outline the Northwind sample kickoff" not in titles
    finally:
        conn.close()


def test_local_meta_is_not_a_preview(client):
    meta = client.get("/api/meta").json()
    assert meta["preview"] is False
    assert meta["preview_banner"] == ""


def test_preview_serves_the_ui_and_resets_on_startup(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>TAFO preview</title>", encoding="utf-8")
    settings = preview_settings(tmp_path / "db", static_dir=str(static))
    app = create_app(settings)
    headers = basic(PASSWORD)
    with TestClient(app) as client:
        meta = client.get("/api/meta", headers=headers).json()
        assert meta["preview"] is True
        assert meta["calendar_mode"] == "demo"
        assert meta["google_configured"] is False
        assert "not synced" in meta["preview_banner"].lower()
        page = client.get("/", headers=headers)
        assert page.status_code == 200
        assert "TAFO preview" in page.text
        created = client.post(
            "/api/tasks",
            json={"title": "Temporary preview task", "domain": "home"},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        titles = {task["title"] for task in client.get("/api/tasks", headers=headers).json()["tasks"]}
        assert "Temporary preview task" in titles
    restarted = create_app(settings)
    with TestClient(restarted) as client:
        titles = {task["title"] for task in client.get("/api/tasks", headers=headers).json()["tasks"]}
        assert "Temporary preview task" not in titles
        assert "Plan Saturday hike route" in titles
        assert client.get("/", headers=headers).status_code == 200


def test_preview_password_gate(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>TAFO preview</title>", encoding="utf-8")
    app = create_app(preview_settings(tmp_path / "db", static_dir=str(static)))
    with TestClient(app) as client:
        missing = client.get("/")
        assert missing.status_code == 401
        assert missing.headers["www-authenticate"] == 'Basic realm="TAFO preview"'
        assert "Plan Saturday hike route" not in missing.text
        wrong = client.get("/api/meta", headers=basic("nope"))
        assert wrong.status_code == 401
        assert wrong.headers["www-authenticate"].startswith("Basic ")
        opened = client.get("/", headers=basic(PASSWORD, username="mike"))
        assert opened.status_code == 200
        assert "TAFO preview" in opened.text
        meta = client.get("/api/tasks", headers=basic(PASSWORD, username=""))
        assert meta.status_code == 200
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json() == {"ok": True}


def test_preview_without_a_password_fails_closed(tmp_path):
    app = create_app(preview_settings(tmp_path, preview_password="  "))
    with TestClient(app) as client:
        denied = client.get("/api/meta")
        assert denied.status_code == 503
        assert "www-authenticate" not in denied.headers
        assert "Plan Saturday hike route" not in denied.text
        assert client.get("/", headers=basic("anything")).status_code == 503
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json() == {"ok": True}


def test_non_preview_is_not_password_gated(monkeypatch, tmp_path):
    monkeypatch.setenv("TAFO_PREVIEW", "0")
    monkeypatch.setenv("PREVIEW_PASSWORD", "should-not-apply")
    monkeypatch.setenv("TAFO_DB_PATH", str(tmp_path / "local.sqlite"))
    monkeypatch.setenv("TAFO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("TAFO_SEED_DEMO", "0")
    monkeypatch.setenv("TAFO_HOST", "127.0.0.1")
    monkeypatch.setenv("TAFO_ALLOW_LAN", "0")
    monkeypatch.setenv("TAFO_CALENDAR_MODE", "demo")
    settings = Settings.from_env()
    assert settings.preview is False
    assert settings.preview_password == ""
    app = create_app(settings)
    with TestClient(app) as client:
        meta = client.get("/api/meta")
        assert meta.status_code == 200
        assert meta.json()["preview"] is False
        assert "www-authenticate" not in meta.headers
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["service"] == "tafo"


def test_image_ignores_env_and_runtime_data():
    text = (ROOT / ".dockerignore").read_text(encoding="utf-8")
    lines = {line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")}
    assert ".env" in lines
    assert "data" in lines
