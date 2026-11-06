"""Editable weekly bullets built from tasks completed in the display timezone."""

from __future__ import annotations

import sqlite3

from tafo.audit import write_audit
from tafo.config import Settings
from tafo.problems import Problem
from tafo.tasks import _tracked_seconds
from tafo.timeutil import parse_utc, utc_now_iso, week_bounds


def render_bullets(conn: sqlite3.Connection, tasks: list[sqlite3.Row]) -> str:
    lines: list[str] = []
    for task in tasks:
        tracked = _tracked_seconds(conn, task["id"]) / 3600
        if task["estimate_hours"] is None:
            estimate = "no estimate"
        else:
            estimate = f"{task['estimate_hours']:g}h est"
        lines.append(f"- {task['title']} ({task['domain']}) — {estimate}, {tracked:.1f}h tracked")
    if not lines:
        return "- (No completed tasks this week yet.)\n"
    return "\n".join(lines) + "\n"


def _completed(conn: sqlite3.Connection, start, end) -> list[sqlite3.Row]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at, id"
    ).fetchall()
    return [row for row in rows if start <= parse_utc(row["completed_at"]) < end]


def _serialize(row: sqlite3.Row, settings: Settings) -> dict:
    return {
        "week_start": row["week_start"],
        "bullets": row["bullets"],
        "version": row["version"],
        "updated_at": row["updated_at"],
        "timezone": settings.display_timezone,
    }


def get_week(conn: sqlite3.Connection, settings: Settings, week_start: str | None) -> dict:
    monday, start, end = week_bounds(settings.display_timezone, week_start)
    row = conn.execute("SELECT * FROM weekly_summaries WHERE week_start = ?", (monday,)).fetchone()
    if row is None:
        bullets = render_bullets(conn, _completed(conn, start, end))
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO weekly_summaries (week_start, bullets, version, updated_at) VALUES (?, ?, 1, ?)",
            (monday, bullets, now),
        )
        row = conn.execute("SELECT * FROM weekly_summaries WHERE week_start = ?", (monday,)).fetchone()
    return _serialize(row, settings)


def save_week(conn: sqlite3.Connection, settings: Settings, week_start: str, bullets: str, expected_version: int, *, actor: str) -> dict:
    if len(bullets) > 20000:
        raise Problem(400, "invalid_bullets", "Weekly bullets are limited to 20000 characters.")
    row = conn.execute("SELECT * FROM weekly_summaries WHERE week_start = ?", (week_start,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Load the week before saving it.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "The weekly bullets changed.", current_version=row["version"])
    now = utc_now_iso()
    cursor = conn.execute(
        "UPDATE weekly_summaries SET bullets = ?, version = version + 1, updated_at = ? WHERE week_start = ? AND version = ?",
        (bullets, now, week_start, expected_version),
    )
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "The weekly bullets changed.")
    write_audit(
        conn,
        actor=actor,
        action="week.update",
        entity_type="week",
        entity_id=week_start,
        detail={},
    )
    stored = conn.execute("SELECT * FROM weekly_summaries WHERE week_start = ?", (week_start,)).fetchone()
    return _serialize(stored, settings)


def regenerate_week(conn: sqlite3.Connection, settings: Settings, week_start: str | None, expected_version: int, *, actor: str) -> dict:
    monday, start, end = week_bounds(settings.display_timezone, week_start)
    existing = get_week(conn, settings, monday)
    if existing["version"] != expected_version:
        raise Problem(409, "version_conflict", "The weekly bullets changed.", current_version=existing["version"])
    bullets = render_bullets(conn, _completed(conn, start, end))
    return save_week(conn, settings, monday, bullets, expected_version, actor=actor)
