"""Idempotent calendar outbox. One proposal approval produces one operation."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import timedelta

from tafo.audit import write_audit
from tafo.calendar_adapter import AdapterResult, CalendarAdapter, StepRecord
from tafo.config import Settings
from tafo.db import session
from tafo.problems import Problem
from tafo.timeutil import new_id, parse_utc, utc_now, utc_now_iso

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
            SET sync_state = 'not_synced', honest_label = ?, updated_at = ?
            WHERE id = ?
            """,
            (result.honest_label, now, event_key),
        )
        return
    cancelled = row["operation"] == "cancel" and result.ok
    status = "cancelled" if cancelled else "scheduled"
    google_event_id = None if written_mode == "demo" else result.google_event_id
    task_id = _task_id_or_none(conn, payload.get("task_id"))
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
                task_id,
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
            task_id,
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


def _task_id_or_none(conn: sqlite3.Connection, task_id: object) -> str | None:
    if not isinstance(task_id, str) or not task_id:
        return None
    row = conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return task_id if row else None


def _retry_after_seconds(row: sqlite3.Row) -> float | None:
    raw = row["result_json"]
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    value = data.get("retry_after")
    if value is None:
        return None
    try:
        return max(0.0, min(float(value), 30.0))
    except (TypeError, ValueError):
        return None


class Outbox:
    """One in-process owner for calendar claims.

    A claim is busy when this process still holds its nonce, or another
    process's lease timestamp is still fresh. There is no os.kill / signal-0
    liveness check: on Windows that signal is not a safe probe. This code was
    exercised on Linux. Windows behavior is simulated by an OSError injection
    and by expiring the lease timestamp; it was not run on Windows.
    """

    PROCESSING = "__tafo_processing__"
    LEASE_SECONDS = 15
    HEARTBEAT_SECONDS = 5
    BUSY_WAIT_SECONDS = 120

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._inflight: dict[str, str] = {}

    def _claim_token(self) -> str:
        return f"{self.PROCESSING}:{os.getpid()}:{uuid.uuid4().hex[:12]}"

    def owner_busy(self, row: sqlite3.Row | dict) -> bool:
        last_error = row["last_error"]
        if not isinstance(last_error, str) or not last_error.startswith(self.PROCESSING):
            return False
        if last_error == self.PROCESSING:
            return False
        prefix, separator, rest = last_error.partition(":")
        if separator != ":" or prefix != self.PROCESSING:
            return False
        pid_text, nonce_sep, nonce = rest.partition(":")
        if not nonce_sep or not nonce:
            return False
        try:
            pid = int(pid_text)
        except ValueError:
            return False
        with self._guard:
            held = self._inflight.get(str(row["id"]))
        if pid == os.getpid():
            return held == nonce
        updated_at = row["updated_at"] if "updated_at" in row.keys() else None
        if not isinstance(updated_at, str):
            return False
        try:
            updated = parse_utc(updated_at)
        except Problem:
            return False
        return utc_now() - updated < timedelta(seconds=self.LEASE_SECONDS)

    def claim(self, conn: sqlite3.Connection, row: sqlite3.Row) -> str | None:
        if self.owner_busy(row):
            return None
        token = self._claim_token()
        previous = row["last_error"]
        owned = conn.execute(
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
        if not owned:
            return None
        nonce = token.rsplit(":", 1)[-1]
        with self._guard:
            self._inflight[str(row["id"])] = nonce
        return token

    def release(self, outbox_id: str) -> None:
        with self._guard:
            self._inflight.pop(outbox_id, None)

    def heartbeat(self, db_path, outbox_id: str, token: str) -> None:
        with session(db_path) as conn:
            conn.execute(
                "UPDATE outbox_operations SET updated_at = ? WHERE id = ? AND last_error = ?",
                (utc_now_iso(), outbox_id, token),
            )

    def persist_event_id(self, conn: sqlite3.Connection, outbox_id: str, token: str, google_event_id: str) -> bool:
        return conn.execute(
            """
            UPDATE outbox_operations
            SET google_event_id = ?, updated_at = ?
            WHERE id = ? AND last_error = ?
            """,
            (google_event_id, utc_now_iso(), outbox_id, token),
        ).rowcount == 1

    def finish(
        self,
        conn: sqlite3.Connection,
        outbox_id: str,
        token: str,
        result: AdapterResult,
        google_event_id: str | None,
    ) -> bool:
        return conn.execute(
            """
            UPDATE outbox_operations
            SET status = ?, google_event_id = ?, last_error = ?,
                honest_label = ?, result_json = ?, updated_at = ?
            WHERE id = ? AND last_error = ?
            """,
            (
                result.status,
                google_event_id,
                result.error,
                result.honest_label,
                json.dumps(result.as_dict()),
                utc_now_iso(),
                outbox_id,
                token,
            ),
        ).rowcount == 1

    def _pulse(self, db_path, outbox_id: str, token: str, stop: threading.Event) -> None:
        while not stop.wait(self.HEARTBEAT_SECONDS):
            try:
                self.heartbeat(db_path, outbox_id, token)
            except Exception:
                return

    def process(self, settings: Settings, adapter: CalendarAdapter, outbox_id: str) -> dict:
        """Claim the attempt, call the adapter with no database lock, then store the result."""
        deadline = time.monotonic() + self.BUSY_WAIT_SECONDS
        claimed = False
        token = ""
        known = None
        payload: dict = {}
        operation = ""
        event_key = ""
        slept_backoff = False
        try:
            while True:
                delay: float | None = None
                with session(settings.db_path) as conn:
                    row = _load_outbox(conn, outbox_id)
                    if row is None:
                        raise Problem(404, "not_found", "Outbox operation not found.")
                    if row["status"] in {"simulated", "synced"}:
                        return serialize_outbox(row)
                    busy = self.owner_busy(row)
                    if (
                        not slept_backoff
                        and not busy
                        and settings.calendar_mode == "live"
                        and row["status"] in {"failed", "partial"}
                    ):
                        delay = _retry_after_seconds(row)
                        if delay is None:
                            exponent = max(0, int(row["attempt_count"]) - 1)
                            delay = min(8.0, 0.2 * (2**exponent))
                    elif not busy:
                        claimed_token = self.claim(conn, row)
                        if claimed_token:
                            token = claimed_token
                            known = row["google_event_id"]
                            payload = json.loads(row["payload_json"])
                            operation = row["operation"]
                            event_key = row["event_key"]
                            claimed = True
                if claimed:
                    break
                if delay is not None:
                    time.sleep(delay)
                    slept_backoff = True
                    continue
                if time.monotonic() > deadline:
                    raise Problem(
                        409,
                        "outbox_busy",
                        "Another calendar attempt is still running. No second remote write was started.",
                    )
                time.sleep(0.05)
            stop = threading.Event()
            beater = threading.Thread(
                target=self._pulse,
                args=(settings.db_path, outbox_id, token, stop),
                daemon=True,
                name=f"tafo-outbox-{outbox_id}",
            )
            beater.start()
            try:
                result = _call_adapter(adapter, operation, event_key, payload, known)
                if settings.calendar_mode == "demo" or getattr(adapter, "mode", "") == "demo":
                    result = enforce_demo(result)
            finally:
                stop.set()
                beater.join(timeout=2)
            gid = _kept_google_id(settings, result, known)
            if gid and settings.calendar_mode != "demo":
                with session(settings.db_path) as conn:
                    if not self.persist_event_id(conn, outbox_id, token, gid):
                        current = _load_outbox(conn, outbox_id)
                        if current is None:
                            raise Problem(404, "not_found", "Outbox operation not found.")
                        return serialize_outbox(current)
            with session(settings.db_path) as conn:
                current = _load_outbox(conn, outbox_id)
                if current is None:
                    raise Problem(404, "not_found", "Outbox operation not found.")
                if current["last_error"] != token:
                    return serialize_outbox(current)
                safe_payload = dict(payload)
                safe_payload["task_id"] = _task_id_or_none(conn, safe_payload.get("task_id"))
                _apply_block(conn, current, safe_payload, result, settings.calendar_mode)
                if not self.finish(conn, outbox_id, token, result, gid):
                    stored = _load_outbox(conn, outbox_id)
                    if stored is None:
                        raise Problem(404, "not_found", "Outbox operation not found.")
                    return serialize_outbox(stored)
                write_audit(
                    conn,
                    actor="human",
                    action="outbox.process",
                    entity_type="outbox",
                    entity_id=outbox_id,
                    detail={
                        "status": result.status,
                        "sync_state": result.sync_state,
                        "attempt": int(current["attempt_count"]),
                    },
                )
                stored = _load_outbox(conn, outbox_id)
                return serialize_outbox(stored)
        finally:
            if claimed:
                self.release(outbox_id)


PROCESSING = Outbox.PROCESSING
_runtime = Outbox()


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
    """Claim the attempt, call the adapter with no database lock, then store the result."""
    return _runtime.process(settings, adapter, outbox_id)
