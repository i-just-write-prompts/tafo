"""Tiny SQL migration runner. Applied versions live in schema_migrations."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from tafo.timeutil import utc_now_iso

MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def split_sql(sql: str) -> list[str]:
    statements: list[str] = []
    buffer: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        buffer.append(line)
        if stripped.endswith(";"):
            statement = "\n".join(buffer).strip().rstrip(";").strip()
            buffer = []
            if statement:
                statements.append(statement)
    tail = "\n".join(buffer).strip().rstrip(";").strip()
    if tail:
        statements.append(tail)
    return statements


def apply_migrations(conn: sqlite3.Connection, directory: Path | None = None) -> list[str]:
    folder = directory or MIGRATIONS
    conn.execute("BEGIN IMMEDIATE")
    applied_now: list[str] = []
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version TEXT PRIMARY KEY,
              applied_at TEXT NOT NULL
            )
            """
        )
        applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations")}
        for path in sorted(folder.glob("*.sql")):
            version = path.stem
            if version in applied:
                continue
            for statement in split_sql(path.read_text(encoding="utf-8")):
                conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, utc_now_iso()),
            )
            applied_now.append(version)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    return applied_now
