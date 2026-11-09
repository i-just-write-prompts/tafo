"""Preview mode is demo-only, public, and reloads the Slice 1 fixture on startup."""

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tafo.app import create_app
from tafo.config import Settings
from tafo.preview import reseed_preview

ROOT = Path(__file__).resolve().parents[2]


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
    )
    fields.update(overrides)
    return Settings(**fields)


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
    with TestClient(app) as client:
        meta = client.get("/api/meta").json()
        assert meta["preview"] is True
        assert meta["calendar_mode"] == "demo"
        assert meta["google_configured"] is False
        assert "not synced" in meta["preview_banner"].lower()
        page = client.get("/")
        assert page.status_code == 200
        assert "TAFO preview" in page.text
        created = client.post("/api/tasks", json={"title": "Temporary preview task", "domain": "home"})
        assert created.status_code == 201, created.text
        titles = {task["title"] for task in client.get("/api/tasks").json()["tasks"]}
        assert "Temporary preview task" in titles
    restarted = create_app(settings)
    with TestClient(restarted) as client:
        titles = {task["title"] for task in client.get("/api/tasks").json()["tasks"]}
        assert "Temporary preview task" not in titles
        assert "Plan Saturday hike route" in titles
        assert client.get("/").status_code == 200


def test_image_ignores_env_and_runtime_data():
    text = (ROOT / ".dockerignore").read_text(encoding="utf-8")
    lines = {line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")}
    assert ".env" in lines
    assert "data" in lines
