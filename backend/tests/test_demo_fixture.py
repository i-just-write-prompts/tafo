"""The Slice 1 review fixture is explicit data, and it stays off the default database."""

import importlib.util
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "load_demo_fixture.py"


def fixture_module():
    spec = importlib.util.spec_from_file_location("load_demo_fixture", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_loader_does_not_call_the_generic_seed():
    text = SCRIPT.read_text()
    assert "seed_if_empty" not in text
    assert "tafo.seed" not in text


def test_refuses_the_default_database(monkeypatch):
    module = fixture_module()
    monkeypatch.chdir(ROOT)
    default = ROOT / "data" / "tafo.sqlite"
    before = default.read_bytes() if default.exists() else None
    with pytest.raises(module.FixturePathError):
        module.JourneyFixture.load(Path("data/tafo.sqlite"))
    with pytest.raises(module.FixturePathError):
        module.JourneyFixture.load(default)
    assert module.main(["data/tafo.sqlite"]) == 2
    after = default.read_bytes() if default.exists() else None
    assert before == after


def test_loads_the_review_journey_into_an_explicit_database(tmp_path):
    module = fixture_module()
    db_path = tmp_path / "review.sqlite"
    module.JourneyFixture.load(db_path)
    module.JourneyFixture.load(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        titles = {row["title"] for row in conn.execute("SELECT title FROM tasks")}
        assert "Plan Saturday hike route" in titles
        assert "Hold the ladder" in titles
        assert "Call Grandma Rosa" in titles
        assert "Outline the Northwind sample kickoff" not in titles
        hike = conn.execute("SELECT id FROM tasks WHERE title = ?", ("Plan Saturday hike route",)).fetchone()
        hike_blocks = conn.execute(
            "SELECT id FROM calendar_blocks WHERE task_id = ?",
            (hike["id"],),
        ).fetchall()
        assert hike_blocks == []
        ladder = conn.execute(
            "SELECT title, fixed, starts_at, ends_at FROM calendar_blocks"
        ).fetchall()
        assert len(ladder) == 1
        assert ladder[0]["title"] == "Hold the ladder"
        assert ladder[0]["fixed"] == 1
        assert ladder[0]["starts_at"] == "2026-11-04T21:00:00Z"
        assert ladder[0]["ends_at"] == "2026-11-04T22:00:00Z"
        proposals = conn.execute(
            "SELECT source_kind, status, idempotency_key FROM proposals ORDER BY idempotency_key"
        ).fetchall()
        pending = [row["idempotency_key"] for row in proposals if row["status"] == "pending"]
        assert pending == ["agent-clean-journey", "agent-door-journey", "agent-herbs-journey"]
        assert all(row["source_kind"] == "agent" for row in proposals if row["status"] == "pending")
        assert sum(1 for row in proposals if row["idempotency_key"] == "plan.fixed.ladder") == 1
    finally:
        conn.close()
