"""Idempotent calendar outbox. One proposal approval produces one operation."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid

from tafo.audit import write_audit
from tafo.calendar_adapter import AdapterResult, CalendarAdapter, StepRecord
from tafo.config import Settings
from tafo.db import read_session, session
from tafo.problems import Problem
from tafo.timeutil import new_id, utc_now_iso

PROCESSING = "__tafo_processing__"
_inflight_guard = threading.Lock()
_inflight: set[str] = set()

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


def _kept_google_id(settings: Settings, result: AdapterResult, known: str | None) -> str | None:
    if settings.calendar_mode == "demo":
        return None
    if result.google_event_id:
        return result.google_event_id
    if result.status in {"failed", "partial"}:
        return known
    return None


def _load_outbox(conn: sqlite3.Connection, outbox_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM outbox_operations WHERE id = ?", (outbox_id,)).fetchone()


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    else:
        return True


def _mark_inflight(outbox_id: str) -> None:
    with _inflight_guard:
        _inflight.add(outbox_id)


def _clear_inflight(outbox_id: str) -> None:
    with _inflight_guard:
        _inflight.discard(outbox_id)


def _is_inflight(outbox_id: str) -> bool:
    with _inflight_guard:
        return outbox_id in _inflight


def _owner_busy(outbox_id: str, last_error: str | None) -> bool:
    """True only when a live attempt still owns the claim.

    A bare ``__tafo_processing__`` token has no pid, so it is a dead claim from
    the previous code. A token whose pid is gone, or whose pid is this process
    but the call is no longer on the stack, is also dead and may be reclaimed.
    """
    if not last_error or not str(last_error).startswith(PROCESSING):
        return False
    if last_error == PROCESSING:
        return False
    _prefix, separator, rest = str(last_error).partition(":")
    if separator != ":" or _prefix != PROCESSING:
        return False
    pid_text, sep, _nonce = rest.partition(":")
    if not sep:
        return False
    try:
        pid = int(pid_text)
    except ValueError:
        return False
    if not _pid_alive(pid):
        return False
    if pid == os.getpid() and not _is_inflight(outbox_id):
        return False
    return True


def _claim_token() -> str:
    return f"{PROCESSING}:{os.getpid()}:{uuid.uuid4().hex[:12]}"


def _cas_claim(conn: sqlite3.Connection, row: sqlite3.Row, token: str) -> bool:
    previous = row["last_error"]
    return conn.execute(
        """
        UPDATE outbox_operations
        SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
        WHERE id = ? AND attempt_count = ? AND status IN ('pending', 'failed', 'partial')
          AND (
            (? IS NULL AND last_error IS NULL)
            OR last_error = ?
          )
        """,
        (
            token,
            utc_now_iso(),
            row["id"],
            row["attempt_count"],
            previous,
            previous,
        ),
    ).rowcount == 1


def _call_adapter(adapter: CalendarAdapter, operation: str, event_key: str, payload: dict, known: str | None) -> AdapterResult:
    try:
        if operation == "create":
            return adapter.create_block(event_key, payload, known)
        if operation == "update":
            return adapter.update_block(event_key, payload, known)
        if operation == "cancel":
            return adapter.cancel_block(event_key, payload, known)
        raise Problem(500, "bad_operation", "Unknown outbox operation.")
    except Problem:
        raise
    except Exception as exc:
        return AdapterResult(
            ok=False,
            status="failed",
            sync_state="not_synced",
            google_event_id=known,
            honest_label="Not synced. The calendar adapter raised an error. The recorded event id was kept when one existed.",
            steps=[StepRecord("adapter", False, str(exc)[:500])],
            error=str(exc)[:500],
            mode=adapter.mode,
        )


def process_outbox(settings: Settings, adapter: CalendarAdapter, outbox_id: str) -> dict:
    """Claim the attempt, call the adapter with no database lock, then store the result.

    A claim whose owner is gone is reclaimed. A claim this process is still inside
    is left alone, so two callers cannot both create the remote event.
    """
    deadline = time.monotonic() + 120
    claimed = False
    known = None
    payload: dict = {}
    operation = ""
    event_key = ""
    try:
        while True:
            with session(settings.db_path) as conn:
                row = _load_outbox(conn, outbox_id)
                if row is None:
                    raise Problem(404, "not_found", "Outbox operation not found.")
                if row["status"] in {"simulated", "synced"}:
                    return serialize_outbox(row)
                known = row["google_event_id"]
                payload = json.loads(row["payload_json"])
                operation = row["operation"]
                event_key = row["event_key"]
                if not _owner_busy(outbox_id, row["last_error"]) and _cas_claim(conn, row, _claim_token()):
                    _mark_inflight(outbox_id)
                    claimed = True
            if claimed:
                break
            if time.monotonic() > deadline:
                raise Problem(
                    409,
                    "outbox_busy",
                    "Another calendar attempt is still running. No second remote write was started.",
                )
            time.sleep(0.05)
        result = _call_adapter(adapter, operation, event_key, payload, known)
        if settings.calendar_mode == "demo" or getattr(adapter, "mode", "") == "demo":
            result = enforce_demo(result)
        gid = _kept_google_id(settings, result, known)
        with session(settings.db_path) as conn:
            current = _load_outbox(conn, outbox_id)
            if current is None:
                raise Problem(404, "not_found", "Outbox operation not found.")
            _apply_block(conn, current, payload, result, settings.calendar_mode)
            now = utc_now_iso()
            conn.execute(
                """
                UPDATE outbox_operations
                SET status = ?, google_event_id = ?, last_error = ?,
                    honest_label = ?, result_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    result.status,
                    gid,
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
                detail={"status": result.status, "sync_state": result.sync_state, "attempt": int(current["attempt_count"])},
            )
            stored = _load_outbox(conn, outbox_id)
            return serialize_outbox(stored)
    finally:
        if claimed:
            _clear_inflight(outbox_id)
