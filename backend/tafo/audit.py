"""Minimal audit rows for decisions and mutations."""

from __future__ import annotations

import json
import sqlite3

from tafo.timeutil import new_id, utc_now_iso


def write_audit(
    conn: sqlite3.Connection,
    *,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    detail: dict,
) -> None:
    conn.execute(
        """
        INSERT INTO audit_log (id, at, actor, action, entity_type, entity_id, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_id("aud"),
            utc_now_iso(),
            actor,
            action,
            entity_type,
            entity_id,
            json.dumps(detail, separators=(",", ":"), default=str),
        ),
    )


def list_audit(conn: sqlite3.Connection, limit: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["detail"] = json.loads(item.pop("detail_json"))
        items.append(item)
    return items
