"""Local records of app-owned calendar blocks. Google remains the live write authority."""

from __future__ import annotations

import sqlite3
from datetime import datetime

from tafo.timeutil import fmt_utc


def serialize_block(row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    item["invite_work_email"] = bool(item["invite_work_email"])
    item["fixed"] = bool(item["fixed"])
    return item


def get_block(conn: sqlite3.Connection, block_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM calendar_blocks WHERE id = ?", (block_id,)).fetchone()
    return serialize_block(row) if row else None


def list_blocks(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM calendar_blocks ORDER BY starts_at, id").fetchall()
    return [serialize_block(row) for row in rows]


def blocks_overlapping(conn: sqlite3.Connection, start: datetime, end: datetime) -> list[dict]:
    rows = conn.execute(
        """
        SELECT * FROM calendar_blocks
        WHERE status = 'scheduled' AND starts_at < ? AND ends_at > ?
        ORDER BY starts_at, id
        """,
        (fmt_utc(end), fmt_utc(start)),
    ).fetchall()
    return [serialize_block(row) for row in rows]
