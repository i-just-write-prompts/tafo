"""Idempotent calendar outbox. One proposal approval produces one operation."""

from __future__ import annotations

import json
import sqlite3

from tafo.audit import write_audit
from tafo.calendar_adapter import AdapterResult, CalendarAdapter, StepRecord
from tafo.config import Settings
from tafo.problems import Problem
from tafo.timeutil import new_id, utc_now_iso

OPERATIONS = {
    "calendar_block": "create",
    "calendar_update": "update",
    "calendar_cancel": "cancel",
}


def serialize_outbox(row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    raw = item.pop("result_json")
    item["result"] = json.loads(raw) if raw else None
    item["payload"] = json.loads(item.pop("payload_json"))
    return item


def outbox_for_proposal(conn: sqlite3.Connection, proposal_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM outbox_operations WHERE proposal_id = ? ORDER BY created_at, id",
        (proposal_id,),
    ).fetchone()
    return serialize_outbox(row) if row else None


def list_outbox(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM outbox_operations ORDER BY created_at DESC, id DESC").fetchall()
    return [serialize_outbox(row) for row in rows]


def ensure_outbox(conn: sqlite3.Connection, proposal_id: str, kind: str, payload: dict, mode: str) -> str:
    operation = OPERATIONS[kind]
    event_key = payload["event_key"]
    idempotency_key = f"proposal:{proposal_id}:{operation}:{event_key}"
    existing = conn.execute(
        "SELECT id FROM outbox_operations WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()
    if existing:
        return existing["id"]
    outbox_id = new_id("obx")
    now = utc_now_iso()
    conn.execute(
        """
        INSERT INTO outbox_operations (
          id, idempotency_key, proposal_id, operation, event_key, payload_json,
          status, mode, attempt_count, google_event_id, last_error, honest_label,
          result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, '', NULL, ?, ?)
        """,
        (outbox_id, idempotency_key, proposal_id, operation, event_key, json.dumps(payload), mode, now, now),
    )
    return outbox_id


def enforce_demo(result: AdapterResult) -> AdapterResult:
    """Demo mode cannot persist a genuine sync or a Google event id."""
    suspicious = result.sync_state == "synced" or result.status == "synced" or bool(result.google_event_id)
    if suspicious:
        return AdapterResult(
            ok=False,
            status="failed",
            sync_state="not_synced",
            google_event_id=None,
            honest_label=(
                "Refused a synced-looking result because TAFO is in demo mode. "
                "NOT synced to Google Calendar. No Google event id was kept."
            ),
            steps=result.steps,
            error="demo_refused_synced_result",
            mode="demo",
        )
    label = result.honest_label or ""
    if "not synced" not in label.lower():
        label = f"{label.rstrip('.')}. NOT synced to Google Calendar."
    status = "simulated" if result.ok else result.status
    if status not in {"simulated", "failed", "partial", "pending"}:
        status = "failed"
    return AdapterResult(
        ok=result.ok,
        status=status,
        sync_state="simulated" if result.ok else "not_synced",
        google_event_id=None,
        honest_label=label,
        steps=result.steps,
        error=result.error,
        mode="demo",
    )


def _apply_block(conn: sqlite3.Connection, row: sqlite3.Row, payload: dict, result: AdapterResult, written_mode: str) -> None:
    event_key = row["event_key"]
    existing = conn.execute("SELECT * FROM calendar_blocks WHERE id = ?", (event_key,)).fetchone()
    now = utc_now_iso()
    if result.status == "failed":
        if existing is None:
            return
        conn.execute(
            """
            UPDATE calendar_blocks
            SET sync_state = 'not_synced', honest_label = ?, updated_at = ?, version = version + 1
            WHERE id = ?
            """,
            (result.honest_label, now, event_key),
        )
        return
    cancelled = row["operation"] == "cancel" and result.ok
    status = "cancelled" if cancelled else "scheduled"
    google_event_id = None if written_mode == "demo" else result.google_event_id
    if existing is None:
        conn.execute(
            """
            INSERT INTO calendar_blocks (
              id, task_id, origin_proposal_id, title, description, starts_at, ends_at, domain,
              invite_work_email, fixed, status, sync_state, written_mode, honest_label,
              google_event_id, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                event_key,
                payload.get("task_id"),
                row["proposal_id"],
                payload["title"],
                payload.get("description") or "",
                payload["starts_at"],
                payload["ends_at"],
                payload["domain"],
                1 if payload.get("invite_work_email") else 0,
                1 if payload.get("fixed") else 0,
                status,
                result.sync_state,
                written_mode,
                result.honest_label,
                google_event_id,
                now,
                now,
            ),
        )
        return
    conn.execute(
        """
        UPDATE calendar_blocks
        SET task_id = ?, title = ?, description = ?, starts_at = ?, ends_at = ?, domain = ?,
            invite_work_email = ?, fixed = ?, status = ?, sync_state = ?, written_mode = ?,
            honest_label = ?, google_event_id = ?, updated_at = ?, version = version + 1
        WHERE id = ?
        """,
        (
            payload.get("task_id"),
            payload["title"],
            payload.get("description") or "",
            payload["starts_at"],
            payload["ends_at"],
            payload["domain"],
            1 if payload.get("invite_work_email") else 0,
            1 if payload.get("fixed") else 0,
            status,
            result.sync_state,
            written_mode,
            result.honest_label,
            google_event_id,
            now,
            event_key,
        ),
    )


def process_outbox(conn: sqlite3.Connection, adapter: CalendarAdapter, settings: Settings, outbox_id: str) -> dict:
    row = conn.execute("SELECT * FROM outbox_operations WHERE id = ?", (outbox_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Outbox operation not found.")
    if row["status"] in {"simulated", "synced"}:
        return serialize_outbox(row)
    payload = json.loads(row["payload_json"])
    attempt = int(row["attempt_count"]) + 1
    known = row["google_event_id"]
    try:
        if row["operation"] == "create":
            result = adapter.create_block(row["event_key"], payload, known)
        elif row["operation"] == "update":
            result = adapter.update_block(row["event_key"], payload, known)
        elif row["operation"] == "cancel":
            result = adapter.cancel_block(row["event_key"], payload, known)
        else:
            raise Problem(500, "bad_operation", "Unknown outbox operation.")
    except Exception as exc:
        result = AdapterResult(
            ok=False,
            status="failed",
            sync_state="not_synced",
            google_event_id=known,
            honest_label="Not synced. The calendar adapter raised an error. No success is claimed.",
            steps=[StepRecord("adapter", False, str(exc)[:500])],
            error=str(exc)[:500],
            mode=adapter.mode,
        )
    if settings.calendar_mode == "demo" or getattr(adapter, "mode", "") == "demo":
        result = enforce_demo(result)
    _apply_block(conn, row, payload, result, settings.calendar_mode)
    now = utc_now_iso()
    conn.execute(
        """
        UPDATE outbox_operations
        SET status = ?, attempt_count = ?, google_event_id = ?, last_error = ?,
            honest_label = ?, result_json = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            result.status,
            attempt,
            None if settings.calendar_mode == "demo" else result.google_event_id,
            result.error,
            result.honest_label,
            json.dumps(result.as_dict()),
            now,
            outbox_id,
        ),
    )
    write_audit(
        conn,
        actor="human",
        action="outbox.process",
        entity_type="outbox",
        entity_id=outbox_id,
        detail={"status": result.status, "sync_state": result.sync_state, "attempt": attempt},
    )
    stored = conn.execute("SELECT * FROM outbox_operations WHERE id = ?", (outbox_id,)).fetchone()
    return serialize_outbox(stored)
