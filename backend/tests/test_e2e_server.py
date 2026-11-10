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
