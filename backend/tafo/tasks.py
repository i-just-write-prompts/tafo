"""Task list, checklist items, manual order, and timer sessions."""

from __future__ import annotations

import sqlite3
from datetime import datetime

from tafo.audit import write_audit
from tafo.outbox import ensure_outbox
from tafo.problems import Problem
from tafo.timeutil import new_id, parse_utc, utc_now, utc_now_iso

DOMAINS = {"work", "home", "personal"}
STATUSES = {"todo", "doing", "waiting", "done"}


def clean_title(value: object) -> str:
    if not isinstance(value, str):
        raise Problem(400, "invalid_title", "Title must be text.")
    title = value.strip()
    if not title or len(title) > 200:
        raise Problem(400, "invalid_title", "Title must be 1–200 characters.")
    return title


def clean_domain(value: object) -> str:
    if value not in DOMAINS:
        raise Problem(400, "invalid_domain", "Domain must be work, home, or personal.")
    return str(value)


def clean_status(value: object) -> str:
    if value not in STATUSES:
        raise Problem(400, "invalid_status", "Status must be todo, doing, waiting, or done.")
    return str(value)


def clean_estimate(value: object) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Problem(400, "invalid_estimate", "Estimate hours must be a number.")
    number = float(value)
    if number <= 0 or number > 100:
        raise Problem(400, "invalid_estimate", "Estimate hours must be greater than 0 and at most 100.")
    return number


def clean_due(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise Problem(400, "invalid_due_date", "Due date must be YYYY-MM-DD.")
    from datetime import date

    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise Problem(400, "invalid_due_date", "Due date must be YYYY-MM-DD.") from exc
    return value


def clean_notes(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise Problem(400, "invalid_notes", "Notes must be text.")
    if len(value) > 5000:
        raise Problem(400, "invalid_notes", "Notes must be at most 5000 characters.")
    return value


def clean_bool(value: object, field: str) -> int:
    if isinstance(value, bool):
        return 1 if value else 0
    if value in {0, 1}:
        return int(value)
    raise Problem(400, "invalid_flag", f"{field} must be true or false.")


def _tracked_seconds(conn: sqlite3.Connection, task_id: str, now: datetime | None = None) -> int:
    moment = now or utc_now()
    total = 0
    rows = conn.execute(
        "SELECT started_at, ended_at FROM timer_sessions WHERE task_id = ?",
        (task_id,),
    ).fetchall()
    for row in rows:
        start = parse_utc(row["started_at"])
        end = parse_utc(row["ended_at"]) if row["ended_at"] else moment
        total += max(0, int((end - start).total_seconds()))
    return total


def _subtasks(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, id",
        (task_id,),
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["done"] = bool(item["done"])
        items.append(item)
    return items


def serialize_task(conn: sqlite3.Connection, row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    item["on_today"] = bool(item["on_today"])
    subtasks = _subtasks(conn, item["id"])
    tracked = _tracked_seconds(conn, item["id"])
    item["subtasks"] = subtasks
    item["tracked_seconds"] = tracked
    item["progress"] = {
        "status": item["status"],
        "checklist_done": sum(1 for sub in subtasks if sub["done"]),
        "checklist_total": len(subtasks),
        "estimate_hours": item["estimate_hours"],
        "tracked_hours": round(tracked / 3600, 2),
    }
    return item


def get_task(conn: sqlite3.Connection, task_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return serialize_task(conn, row) if row else None


def list_tasks(conn: sqlite3.Connection, view: str, scope: str) -> list[dict]:
    if view not in {"all", "work", "life"}:
        raise Problem(400, "invalid_view", "View must be all, work, or life.")
    if scope not in {"all", "today", "backlog"}:
        raise Problem(400, "invalid_scope", "Scope must be all, today, or backlog.")
    clauses: list[str] = []
    if view == "work":
        clauses.append("domain = 'work'")
    elif view == "life":
        clauses.append("domain IN ('home', 'personal')")
    if scope == "today":
        clauses.append("on_today = 1")
    elif scope == "backlog":
        clauses.append("on_today = 0")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(f"SELECT * FROM tasks {where} ORDER BY sort_order, created_at, id").fetchall()
    return [serialize_task(conn, row) for row in rows]


def _next_sort(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COALESCE(MAX(sort_order), 0) AS n FROM tasks").fetchone()
    return int(row["n"]) + 10


def create_task(conn: sqlite3.Connection, fields: dict, *, actor: str) -> dict:
    now = utc_now_iso()
    title = clean_title(fields.get("title"))
    domain = clean_domain(fields.get("domain"))
    status = clean_status(fields.get("status", "todo"))
    estimate = clean_estimate(fields.get("estimate_hours"))
    due = clean_due(fields.get("due_date"))
    notes = clean_notes(fields.get("notes", ""))
    on_today = clean_bool(fields.get("on_today", False), "on_today")
    sort_order = fields.get("sort_order", _next_sort(conn))
    if isinstance(sort_order, bool) or not isinstance(sort_order, int):
        raise Problem(400, "invalid_sort", "sort_order must be an integer.")
    task_id = fields.get("id") or new_id("task")
    if not isinstance(task_id, str) or len(task_id) < 4:
        raise Problem(400, "invalid_id", "Task id is invalid.")
    completed = now if status == "done" else None
    conn.execute(
        """
        INSERT INTO tasks (
          id, title, domain, status, estimate_hours, due_date, notes, sort_order,
          on_today, version, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        """,
        (task_id, title, domain, status, estimate, due, notes, sort_order, on_today, now, now, completed),
    )
    write_audit(
        conn,
        actor=actor,
        action="task.create",
        entity_type="task",
        entity_id=task_id,
        detail={"title": title, "domain": domain},
    )
    task = get_task(conn, task_id)
    assert task is not None
    return task


def update_task(conn: sqlite3.Connection, task_id: str, changes: dict, expected_version: int, *, actor: str) -> dict:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Task not found.")
    if row["version"] != expected_version:
        raise Problem(
            409,
            "version_conflict",
            "This task changed since you loaded it. Reload and try again.",
            current_version=row["version"],
        )
    allowed = {
        "title": clean_title,
        "domain": clean_domain,
        "status": clean_status,
        "estimate_hours": clean_estimate,
        "due_date": clean_due,
        "notes": clean_notes,
        "on_today": lambda value: clean_bool(value, "on_today"),
    }
    assignments: list[str] = []
    values: list[object] = []
    applied: dict = {}
    for key, value in changes.items():
        if key not in allowed:
            raise Problem(400, "invalid_field", f"{key} cannot be changed here.")
        cleaned = allowed[key](value)
        assignments.append(f"{key} = ?")
        values.append(cleaned)
        applied[key] = cleaned
    if "status" in applied:
        if applied["status"] == "done":
            completed = row["completed_at"] if row["status"] == "done" else utc_now_iso()
        else:
            completed = None
        assignments.append("completed_at = ?")
        values.append(completed)
    if not assignments:
        raise Problem(400, "empty_update", "No changes were provided.")
    now = utc_now_iso()
    assignments.extend(["version = version + 1", "updated_at = ?"])
    values.append(now)
    values.extend([task_id, expected_version])
    cursor = conn.execute(
        f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ? AND version = ?",
        values,
    )
    if cursor.rowcount != 1:
        current = conn.execute("SELECT version FROM tasks WHERE id = ?", (task_id,)).fetchone()
        raise Problem(
            409,
            "version_conflict",
            "This task changed since you loaded it. Reload and try again.",
            current_version=None if current is None else current["version"],
        )
    write_audit(
        conn,
        actor=actor,
        action="task.update",
        entity_type="task",
        entity_id=task_id,
        detail={"changes": list(applied.keys())},
    )
    task = get_task(conn, task_id)
    assert task is not None
    return task


def delete_task(
    conn: sqlite3.Connection,
    task_id: str,
    expected_version: int,
    *,
    actor: str,
    calendar_mode: str,
) -> list[str]:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Task not found.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This task changed since you loaded it.", current_version=row["version"])
    blocks = conn.execute(
        "SELECT * FROM calendar_blocks WHERE task_id = ? AND status = 'scheduled'",
        (task_id,),
    ).fetchall()
    cancel_ids: list[str] = []
    for block in blocks:
        payload = {
            "event_key": block["id"],
            "task_id": None,
            "title": block["title"],
            "description": block["description"],
            "starts_at": block["starts_at"],
            "ends_at": block["ends_at"],
            "domain": block["domain"],
            "invite_work_email": bool(block["invite_work_email"]),
            "fixed": bool(block["fixed"]),
        }
        proposal_id = block["origin_proposal_id"] or f"taskdel:{task_id}"
        outbox_id = ensure_outbox(conn, proposal_id, "calendar_cancel", payload, calendar_mode)
        if calendar_mode != "demo" and block["google_event_id"]:
            conn.execute(
                "UPDATE outbox_operations SET google_event_id = ? WHERE id = ? AND google_event_id IS NULL",
                (block["google_event_id"], outbox_id),
            )
        cancel_ids.append(outbox_id)
    cursor = conn.execute("DELETE FROM tasks WHERE id = ? AND version = ?", (task_id, expected_version))
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This task changed since you loaded it.")
    write_audit(conn, actor=actor, action="task.delete", entity_type="task", entity_id=task_id, detail={"cancellations": cancel_ids})
    return cancel_ids


def move_task(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    direction: str,
    view: str,
    scope: str,
    expected_version: int,
    actor: str,
) -> dict:
    if direction not in {"up", "down"}:
        raise Problem(400, "invalid_direction", "Direction must be up or down.")
    visible = list_tasks(conn, view, scope)
    index = next((i for i, task in enumerate(visible) if task["id"] == task_id), None)
    if index is None:
        raise Problem(404, "not_found", "Task is not in that view.")
    swap_index = index - 1 if direction == "up" else index + 1
    if swap_index < 0 or swap_index >= len(visible):
        task = get_task(conn, task_id)
        assert task is not None
        return task
    current = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    other = conn.execute("SELECT * FROM tasks WHERE id = ?", (visible[swap_index]["id"],)).fetchone()
    if current is None or other is None:
        raise Problem(404, "not_found", "Task not found.")
    if current["version"] != expected_version:
        raise Problem(409, "version_conflict", "This task changed since you loaded it.", current_version=current["version"])
    current_order = int(current["sort_order"])
    other_order = int(other["sort_order"])
    if current_order == other_order:
        new_current = other_order - 1 if direction == "up" else other_order + 1
        new_other = other_order
    else:
        new_current, new_other = other_order, current_order
    now = utc_now_iso()
    cursor = conn.execute(
        "UPDATE tasks SET sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        (new_current, now, current["id"], expected_version),
    )
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This task changed since you loaded it.")
    neighbor = conn.execute(
        "UPDATE tasks SET sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        (new_other, now, other["id"], other["version"]),
    )
    if neighbor.rowcount != 1:
        raise Problem(409, "version_conflict", "Another task in this list changed. Reload and try again.")
    write_audit(
        conn,
        actor=actor,
        action="task.reorder",
        entity_type="task",
        entity_id=task_id,
        detail={"direction": direction, "view": view, "scope": scope},
    )
    task = get_task(conn, task_id)
    assert task is not None
    return task


def add_subtask(conn: sqlite3.Connection, task_id: str, title: str, *, actor: str) -> dict:
    if get_task(conn, task_id) is None:
        raise Problem(404, "not_found", "Task not found.")
    cleaned = clean_title(title)
    row = conn.execute("SELECT COALESCE(MAX(sort_order), 0) AS n FROM subtasks WHERE task_id = ?", (task_id,)).fetchone()
    sub_id = new_id("sub")
    conn.execute(
        "INSERT INTO subtasks (id, task_id, title, done, sort_order, version) VALUES (?, ?, ?, 0, ?, 1)",
        (sub_id, task_id, cleaned, int(row["n"]) + 10),
    )
    write_audit(conn, actor=actor, action="subtask.create", entity_type="subtask", entity_id=sub_id, detail={"task_id": task_id})
    stored = conn.execute("SELECT * FROM subtasks WHERE id = ?", (sub_id,)).fetchone()
    item = dict(stored)
    item["done"] = bool(item["done"])
    return item


def update_subtask(conn: sqlite3.Connection, sub_id: str, changes: dict, expected_version: int, *, actor: str) -> dict:
    row = conn.execute("SELECT * FROM subtasks WHERE id = ?", (sub_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Checklist item not found.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This checklist item changed.", current_version=row["version"])
    assignments: list[str] = []
    values: list[object] = []
    if "title" in changes:
        assignments.append("title = ?")
        values.append(clean_title(changes["title"]))
    if "done" in changes:
        assignments.append("done = ?")
        values.append(clean_bool(changes["done"], "done"))
    if not assignments:
        raise Problem(400, "empty_update", "No changes were provided.")
    assignments.append("version = version + 1")
    values.extend([sub_id, expected_version])
    cursor = conn.execute(
        f"UPDATE subtasks SET {', '.join(assignments)} WHERE id = ? AND version = ?",
        values,
    )
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This checklist item changed.")
    write_audit(conn, actor=actor, action="subtask.update", entity_type="subtask", entity_id=sub_id, detail={})
    stored = conn.execute("SELECT * FROM subtasks WHERE id = ?", (sub_id,)).fetchone()
    item = dict(stored)
    item["done"] = bool(item["done"])
    return item


def delete_subtask(conn: sqlite3.Connection, sub_id: str, expected_version: int, *, actor: str) -> None:
    row = conn.execute("SELECT * FROM subtasks WHERE id = ?", (sub_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Checklist item not found.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This checklist item changed.", current_version=row["version"])
    cursor = conn.execute("DELETE FROM subtasks WHERE id = ? AND version = ?", (sub_id, expected_version))
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This checklist item changed.")
    write_audit(conn, actor=actor, action="subtask.delete", entity_type="subtask", entity_id=sub_id, detail={})


def _active_timer(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM timer_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").fetchone()


def serialize_timer(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    task = conn.execute("SELECT title FROM tasks WHERE id = ?", (row["task_id"],)).fetchone()
    end = parse_utc(row["ended_at"]) if row["ended_at"] else utc_now()
    start = parse_utc(row["started_at"])
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "task_title": None if task is None else task["title"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "running": row["ended_at"] is None,
        "elapsed_seconds": max(0, int((end - start).total_seconds())),
    }


def active_timer(conn: sqlite3.Connection) -> dict | None:
    row = _active_timer(conn)
    return None if row is None else serialize_timer(conn, row)


def start_timer(conn: sqlite3.Connection, task_id: str, *, actor: str) -> dict:
    if get_task(conn, task_id) is None:
        raise Problem(404, "not_found", "Task not found.")
    running = _active_timer(conn)
    if running is not None:
        raise Problem(
            409,
            "timer_active",
            "Stop the running timer before starting another.",
            active_task_id=running["task_id"],
        )
    timer_id = new_id("tim")
    started = utc_now_iso()
    conn.execute(
        "INSERT INTO timer_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, NULL)",
        (timer_id, task_id, started),
    )
    write_audit(conn, actor=actor, action="timer.start", entity_type="timer", entity_id=timer_id, detail={"task_id": task_id})
    row = conn.execute("SELECT * FROM timer_sessions WHERE id = ?", (timer_id,)).fetchone()
    return serialize_timer(conn, row)


def stop_timer(conn: sqlite3.Connection, task_id: str, *, actor: str) -> dict:
    row = conn.execute(
        "SELECT * FROM timer_sessions WHERE task_id = ? AND ended_at IS NULL",
        (task_id,),
    ).fetchone()
    if row is None:
        raise Problem(409, "timer_not_running", "This task has no running timer.")
    ended = utc_now_iso()
    conn.execute("UPDATE timer_sessions SET ended_at = ? WHERE id = ?", (ended, row["id"]))
    write_audit(conn, actor=actor, action="timer.stop", entity_type="timer", entity_id=row["id"], detail={"task_id": task_id})
    stored = conn.execute("SELECT * FROM timer_sessions WHERE id = ?", (row["id"],)).fetchone()
    return serialize_timer(conn, stored)
