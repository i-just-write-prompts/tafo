"""Migration 003 keeps existing calendar rows intact."""

from __future__ import annotations

from pathlib import Path

import pytest

from tafo.db import connect, session
from tafo.migrate import apply_migrations


@pytest.fixture()
def throwaway_db(tmp_path: Path) -> Path:
    return tmp_path / "slice2.sqlite"


def test_migration_preserves_calendar_blocks(throwaway_db: Path, tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "tafo" / "migrations"
    stage = tmp_path / "migrations"
    stage.mkdir()
    for name in ("001_init.sql", "002_indexes.sql"):
        (stage / name).write_text((source / name).read_text(encoding="utf-8"), encoding="utf-8")
    conn = connect(throwaway_db)
    try:
        apply_migrations(conn, directory=stage)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO calendar_blocks (
              id, task_id, title, description, starts_at, ends_at, domain,
              invite_work_email, fixed, status, sync_state, written_mode, honest_label,
              version, created_at, updated_at
            ) VALUES (
              'block-legacy', NULL, 'Legacy item', '', '2026-11-10T14:00:00Z', '2026-11-10T15:00:00Z', 'work',
              0, 0, 'scheduled', 'simulated', 'demo', 'Demo', 1, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'
            )
            """
        )
        conn.execute("COMMIT")
    finally:
        conn.close()
    (stage / "003_slice2.sql").write_text((source / "003_slice2.sql").read_text(encoding="utf-8"), encoding="utf-8")
    conn = connect(throwaway_db)
    try:
        applied = apply_migrations(conn, directory=stage)
        assert applied == ["003_slice2"]
        row = conn.execute("SELECT title FROM calendar_blocks WHERE id = 'block-legacy'").fetchone()
        assert row is not None
        assert row["title"] == "Legacy item"
        tables = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        assert "category_hours" in tables
        assert "sacred_windows" in tables
        assert "feedback_submissions" in tables
    finally:
        conn.close()


def test_ensure_defaults_seeds_hours(throwaway_db: Path) -> None:
    from tafo.hours_store import ensure_defaults, hours_payload

    conn = connect(throwaway_db)
    try:
        apply_migrations(conn, directory=Path(__file__).resolve().parents[1] / "tafo" / "migrations")
        ensure_defaults(conn)
        payload = hours_payload(conn)
        assert payload["category_hours"]
        assert len(payload["sacred_windows"]) >= 2
    finally:
        conn.close()
