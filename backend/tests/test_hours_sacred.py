"""Sacred windows block agent slot suggestions."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from tafo.availability import suggest_slot
from tafo.calendar_adapter import build_adapter
from tafo.config import Settings
from tafo.db import connect, session
from tafo.hours_store import ensure_defaults, overlapping_sacred, upsert_sacred
from tafo.migrate import apply_migrations


def test_sacred_overlap_detection(tmp_path: Path) -> None:
    db_path = tmp_path / "hours.sqlite"
    conn = connect(db_path)
    try:
        apply_migrations(conn)
        ensure_defaults(conn)
    finally:
        conn.close()
    with session(db_path) as conn:
        hits = overlapping_sacred(conn, weekday=1, start_min=18 * 60, end_min=19 * 60, agent_only=True)
        assert any(row["name"] == "Family dinner" for row in hits)


def test_suggest_slot_avoids_sacred(tmp_path: Path) -> None:
    db_path = tmp_path / "suggest.sqlite"
    settings = Settings(
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
        slice2=True,
    )
    conn = connect(db_path)
    try:
        apply_migrations(conn)
        ensure_defaults(conn)
    finally:
        conn.close()
    with session(db_path) as conn:
        upsert_sacred(
            conn,
            {
                "name": "All day block",
                "days_mask": 127,
                "start_minutes": 9 * 60,
                "end_minutes": 17 * 60,
                "agent_block": True,
                "heads_up": True,
            },
        )
    adapter = build_adapter(settings)
    result = suggest_slot(settings, adapter, duration_minutes=60)
    chosen = datetime.fromisoformat(result["starts_at"].replace("Z", "+00:00"))
    assert chosen.tzinfo == timezone.utc
    # With work hours fully sacred, fallback still returns something but not inside 9-17 local if avoid logic works
    local = chosen.astimezone()
    weekday = local.weekday()
    minute = local.hour * 60 + local.minute
    with session(db_path) as conn:
        sacred_hits = overlapping_sacred(conn, weekday, minute, minute + 60, agent_only=True)
    assert not sacred_hits
