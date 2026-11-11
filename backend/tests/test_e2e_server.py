"""The Playwright server reloads the v3 week and stays off the default database."""

import importlib.util
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "e2e_server.py"


def server_module():
    spec = importlib.util.spec_from_file_location("e2e_server", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_reset_refuses_the_default_database(monkeypatch):
    module = server_module()
    monkeypatch.chdir(ROOT)
    default = ROOT / "data" / "tafo.sqlite"
    before = default.read_bytes() if default.exists() else None
    refused = module.fixture_module().FixturePathError
    with pytest.raises(refused):
        module.reset_database(Path("data/tafo.sqlite"))
    with pytest.raises(refused):
        module.reset_database(default)
    after = default.read_bytes() if default.exists() else None
    assert before == after


def test_reset_reloads_the_review_fixture(tmp_path):
    module = server_module()
    db_path = tmp_path / "tafo.sqlite"
    module.reset_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("DELETE FROM tasks")
        conn.commit()
    finally:
        conn.close()
    module.reset_database(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        titles = {row["title"] for row in conn.execute("SELECT title FROM tasks")}
        assert "Call vendor" in titles
        assert "Spec review" in titles
        assert "Budget sheet" in titles
        assert "Outline the Northwind sample kickoff" not in titles
        pending = [
            row["idempotency_key"]
            for row in conn.execute(
                "SELECT idempotency_key FROM proposals WHERE status = 'pending' ORDER BY idempotency_key"
            )
        ]
        assert pending == ["v3-budget", "v3-closet"]
    finally:
        conn.close()


def test_reset_is_post_and_not_swallowed_by_the_ui(tmp_path):
    """POST /api/e2e/reset reloads the demo week. The route allows only POST.

    A static UI mounted at / answers other methods with 405 Allow: GET, HEAD.
    The reset route has to be registered ahead of that mount, or Playwright's
    POST looks like a missing route.
    """
    module = server_module()
    static = tmp_path / "ui"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>tafo</title>", encoding="utf-8")
    db = tmp_path / "throwaway" / "tafo.sqlite"
    module.reset_database(db)
    from fastapi.testclient import TestClient

    from tafo.app import create_app
    from tafo.config import Settings

    settings = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=db.parent,
        db_path=db,
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
        static_dir=str(static),
        e2e=True,
    )
    app = create_app(settings)
    module.register_e2e_reset(app, db)
    reset_routes = [route for route in app.router.routes if getattr(route, "path", None) == "/api/e2e/reset"]
    assert len(reset_routes) == 1
    assert reset_routes[0].methods == {"POST"}
    with TestClient(app) as client:
        posted = client.post("/api/e2e/reset")
        assert posted.status_code == 200, posted.text
        body = posted.json()
        assert body["ok"] is True
        assert body["db"].endswith("tafo.sqlite")
        assert "data/tafo.sqlite" not in body["db"].replace("\\", "/")
        # GET is not the reseed. With the UI mounted it falls through to static files.
        got = client.get("/api/e2e/reset")
        assert got.status_code != 200
