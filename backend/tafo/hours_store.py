"""Category hours and sacred windows for slice 2."""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from tafo.timeutil import utc_now_iso

WEEKDAYS = range(7)
DOMAINS = ("work", "home", "personal")

# Defaults from AC 41: Work Mon–Fri 9–5; Home weeknights 5–10 PM and weekends; Personal any time.
DEFAULT_HOURS: dict[str, list[tuple[int, int, int]]] = {
    "work": [(d, 9 * 60, 17 * 60) for d in range(5)],
    "home": [(d, 17 * 60, 22 * 60) for d in range(5)] + [(d, 0, 24 * 60) for d in (5, 6)],
    "personal": [(d, 0, 24 * 60) for d in WEEKDAYS],
}


def ensure_defaults(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT COUNT(*) AS c FROM category_hours").fetchone()
    if row and int(row["c"]) > 0:
        return
    now = utc_now_iso()
    for domain, spans in DEFAULT_HOURS.items():
        for weekday, start, end in spans:
            conn.execute(
                "INSERT INTO category_hours (domain, weekday, start_minutes, end_minutes) VALUES (?, ?, ?, ?)",
                (domain, weekday, start, end),
            )
    if conn.execute("SELECT COUNT(*) AS c FROM sacred_windows").fetchone()["c"] == 0:
        conn.execute(
            """
            INSERT INTO sacred_windows (
              id, name, days_mask, start_minutes, end_minutes, agent_block, heads_up, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)
            """,
            (
                "sacred-family-dinner",
                "Family dinner",
                days_mask_all(),
                18 * 60,
                19 * 60 + 30,
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO sacred_windows (
              id, name, days_mask, start_minutes, end_minutes, agent_block, heads_up, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)
            """,
            (
                "sacred-morning-run",
                "Morning run",
                days_mask([0, 2, 4]),
                6 * 60 + 30,
                7 * 60 + 30,
                now,
                now,
            ),
        )


def days_mask(weekdays: list[int]) -> int:
    mask = 0
    for day in weekdays:
        mask |= 1 << day
    return mask


def days_mask_all() -> int:
    return sum(1 << d for d in WEEKDAYS)


def list_category_hours(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT domain, weekday, start_minutes, end_minutes FROM category_hours ORDER BY domain, weekday, start_minutes"
    ).fetchall()
    return [dict(row) for row in rows]


def list_sacred_windows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, name, days_mask, start_minutes, end_minutes, agent_block, heads_up, version, created_at, updated_at
        FROM sacred_windows ORDER BY start_minutes, name
        """
    ).fetchall()
    return [dict(row) for row in rows]


def sacred_summary(conn: sqlite3.Connection) -> str:
    ensure_defaults(conn)
    work = conn.execute(
        "SELECT MIN(start_minutes) AS s, MAX(end_minutes) AS e FROM category_hours WHERE domain = 'work' AND weekday < 5"
    ).fetchone()
    if work and work["s"] is not None:
        work_line = f"Work {minutes_clock(work['s'])}–{minutes_clock(work['e'])}"
    else:
        work_line = "Work 9–5"
    count = conn.execute("SELECT COUNT(*) AS c FROM sacred_windows").fetchone()["c"]
    sacred = f"{count} sacred window{'s' if count != 1 else ''}"
    return f"{work_line} · {sacred}"


def minutes_clock(total: int) -> str:
    hour = total // 60
    minute = total % 60
    if minute == 0:
        suffix = " AM" if hour < 12 else " PM"
        shown = hour % 12 or 12
        return f"{shown}{suffix}".strip()
    suffix = " AM" if hour < 12 else " PM"
    shown = hour % 12 or 12
    return f"{shown}:{minute:02d}{suffix}"


def replace_category_hours(conn: sqlite3.Connection, spans: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM category_hours")
    for item in spans:
        conn.execute(
            "INSERT INTO category_hours (domain, weekday, start_minutes, end_minutes) VALUES (?, ?, ?, ?)",
            (item["domain"], int(item["weekday"]), int(item["start_minutes"]), int(item["end_minutes"])),
        )


def upsert_sacred(conn: sqlite3.Connection, body: dict[str, Any]) -> dict[str, Any]:
    window_id = body.get("id") or f"sacred-{uuid.uuid4().hex[:12]}"
    now = utc_now_iso()
    existing = conn.execute("SELECT version, created_at FROM sacred_windows WHERE id = ?", (window_id,)).fetchone()
    version = int(existing["version"]) + 1 if existing else 1
    created = existing["created_at"] if existing else now
    if existing:
        conn.execute(
            """
            UPDATE sacred_windows SET
              name = ?, days_mask = ?, start_minutes = ?, end_minutes = ?,
              agent_block = ?, heads_up = ?, version = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                body["name"],
                int(body["days_mask"]),
                int(body["start_minutes"]),
                int(body["end_minutes"]),
                1 if body.get("agent_block", True) else 0,
                1 if body.get("heads_up", True) else 0,
                version,
                now,
                window_id,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO sacred_windows (
              id, name, days_mask, start_minutes, end_minutes, agent_block, heads_up, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                window_id,
                body["name"],
                int(body["days_mask"]),
                int(body["start_minutes"]),
                int(body["end_minutes"]),
                1 if body.get("agent_block", True) else 0,
                1 if body.get("heads_up", True) else 0,
                version,
                created,
                now,
            ),
        )
    return dict(conn.execute("SELECT * FROM sacred_windows WHERE id = ?", (window_id,)).fetchone())


def delete_sacred(conn: sqlite3.Connection, window_id: str) -> None:
    conn.execute("DELETE FROM sacred_windows WHERE id = ?", (window_id,))


def hours_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    ensure_defaults(conn)
    return {
        "category_hours": list_category_hours(conn),
        "sacred_windows": list_sacred_windows(conn),
        "summary": sacred_summary(conn),
    }


def local_minutes(dt, tz_name: str) -> int:
    from zoneinfo import ZoneInfo

    local = dt.astimezone(ZoneInfo(tz_name))
    return local.hour * 60 + local.minute


def in_category_hours(conn: sqlite3.Connection, domain: str, weekday: int, start_min: int, end_min: int) -> bool:
    rows = conn.execute(
        "SELECT start_minutes, end_minutes FROM category_hours WHERE domain = ? AND weekday = ?",
        (domain, weekday),
    ).fetchall()
    if not rows:
        return True
    for row in rows:
        if start_min >= row["start_minutes"] and end_min <= row["end_minutes"]:
            return True
    return False


def overlapping_sacred(
    conn: sqlite3.Connection,
    weekday: int,
    start_min: int,
    end_min: int,
    *,
    agent_only: bool = False,
) -> list[dict[str, Any]]:
    rows = list_sacred_windows(conn)
    hits: list[dict[str, Any]] = []
    for row in rows:
        if agent_only and not row["agent_block"]:
            continue
        if (int(row["days_mask"]) & (1 << weekday)) == 0:
            continue
        s, e = int(row["start_minutes"]), int(row["end_minutes"])
        if end_min <= s or start_min >= e:
            continue
        hits.append(row)
    return hits
