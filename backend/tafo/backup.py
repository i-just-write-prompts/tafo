"""JSON backup, export, and restore of the local SQLite data."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from tafo.problems import Problem
from tafo.timeutil import utc_now_iso

TABLES = [
    "tasks",
    "subtasks",
    "timer_sessions",
    "weekly_summaries",
    "proposals",
    "calendar_blocks",
    "outbox_operations",
    "audit_log",
]
DELETE_ORDER = [
    "outbox_operations",
    "timer_sessions",
    "subtasks",
    "calendar_blocks",
    "proposals",
    "weekly_summaries",
    "audit_log",
    "tasks",
]


def export_snapshot(conn: sqlite3.Connection) -> dict:
    tables: dict[str, list[dict]] = {}
    for name in TABLES:
        rows = conn.execute(f"SELECT * FROM {name}").fetchall()
        tables[name] = [dict(row) for row in rows]
    return {
        "format": "tafo-backup",
        "format_version": 1,
        "exported_at": utc_now_iso(),
        "tables": tables,
    }


def write_backup_file(conn: sqlite3.Connection, data_dir: Path) -> Path:
    folder = data_dir / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = utc_now_iso().replace("-", "").replace(":", "")
    path = folder / f"tafo-{stamp}.json"
    path.write_text(json.dumps(export_snapshot(conn), indent=2), encoding="utf-8")
    return path


def restore_snapshot(conn: sqlite3.Connection, snapshot: dict) -> dict:
    if snapshot.get("format") != "tafo-backup" or snapshot.get("format_version") != 1:
        raise Problem(400, "invalid_backup", "Unrecognized backup. Expected tafo-backup format version 1.")
    tables = snapshot.get("tables")
    if not isinstance(tables, dict):
        raise Problem(400, "invalid_backup", "Backup is missing tables.")
    for name in TABLES:
        if not isinstance(tables.get(name), list):
            raise Problem(400, "invalid_backup", f"Backup is missing table {name}.")
    prepared: dict[str, tuple[list[str], list[list[object]]]] = {}
    for name in TABLES:
        info = conn.execute(f"PRAGMA table_info({name})").fetchall()
        columns = [row["name"] for row in info]
        allowed = set(columns)
        packed: list[list[object]] = []
        for item in tables[name]:
            if not isinstance(item, dict):
                raise Problem(400, "invalid_backup", f"A {name} row is not an object.")
            extra = set(item) - allowed
            if extra:
                raise Problem(400, "invalid_backup", f"Unknown column in {name}.")
            packed.append([item.get(column) for column in columns])
        prepared[name] = (columns, packed)
    for name in DELETE_ORDER:
        conn.execute(f"DELETE FROM {name}")
    for name in TABLES:
        columns, packed = prepared[name]
        if not packed:
            continue
        placeholders = ", ".join("?" for _ in columns)
        sql = f"INSERT INTO {name} ({', '.join(columns)}) VALUES ({placeholders})"
        conn.executemany(sql, packed)
    return {"restored": True, "tables": {name: len(tables[name]) for name in TABLES}}
