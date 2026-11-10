"""Proposal inbox and the human decision gate.

Agents can insert proposals. Applying a task change or writing the calendar
outbox happens only from an approved decision.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import timedelta

from tafo.audit import write_audit
from tafo.availability import availability_report
from tafo.blocks import get_block
from tafo.calendar_adapter import GENERIC_DESCRIPTION, GENERIC_TITLE, CalendarAdapter
from tafo.config import Settings
from tafo.db import read_session, session
from tafo.outbox import ensure_outbox, outbox_for_proposal
from tafo.problems import Problem
from tafo.tasks import clean_title, create_task, get_task, update_task
from tafo.timeutil import fmt_utc, local_naive_to_utc, new_id, parse_utc, utc_now_iso

EVENT_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
IDEM_RE = re.compile(r"^[A-Za-z0-9_.:-]{6,120}$")
TASK_FIELDS = {"title", "domain", "status", "estimate_hours", "due_date", "notes", "on_today"}


def _loads(value: str | None):
    if not value:
        return None
    return json.loads(value)


def effective_payload(row: sqlite3.Row | dict) -> dict:
    raw = row["edited_payload_json"] or row["payload_json"]
    return json.loads(raw)


def serialize_proposal(row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    item["payload"] = json.loads(item.pop("payload_json"))
    item["edited_payload"] = _loads(item.pop("edited_payload_json"))
    item["availability"] = _loads(item.pop("availability_json"))
    return item


def get_proposal(conn: sqlite3.Connection, proposal_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    return serialize_proposal(row) if row else None


def list_proposals(conn: sqlite3.Connection, status: str | None) -> list[dict]:
    if status:
        if status not in {"pending", "approved", "rejected"}:
            raise Problem(400, "invalid_status", "Status filter must be pending, approved, or rejected.")
        rows = conn.execute(
            "SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 100",
            (status,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM proposals ORDER BY created_at DESC, id DESC LIMIT 100").fetchall()
    return [serialize_proposal(row) for row in rows]


def _span(raw: dict, settings: Settings):
    tz_name = raw.get("timezone") or settings.display_timezone
    has_utc = raw.get("starts_at") and raw.get("ends_at")
    has_local = raw.get("starts_local") and raw.get("ends_local")
    if has_utc:
        start, end = parse_utc(str(raw["starts_at"])), parse_utc(str(raw["ends_at"]))
    elif has_local:
        start = local_naive_to_utc(str(raw["starts_local"]), str(tz_name))
        end = local_naive_to_utc(str(raw["ends_local"]), str(tz_name))
    else:
        raise Problem(400, "invalid_span", "Provide starts_at and ends_at, or starts_local and ends_local.")
    if end <= start:
        raise Problem(400, "invalid_span", "End must be after start.")
    if end - start > timedelta(hours=12):
        raise Problem(400, "invalid_span", "Blocks in this MVP are limited to 12 hours.")
    return start, end


def _event_key(raw: dict, *, required: bool) -> str:
    value = raw.get("event_key") or raw.get("block_id")
    if not value:
        if required:
            raise Problem(400, "invalid_event_key", "This proposal needs the block id in event_key.")
        value = new_id("evt")
    if not isinstance(value, str) or not EVENT_KEY_RE.fullmatch(value):
        raise Problem(400, "invalid_event_key", "event_key must be 8–80 letters, numbers, underscores, or hyphens.")
    return value


def _task_id(conn: sqlite3.Connection, raw: dict) -> str | None:
    task_id = raw.get("task_id")
    if task_id in (None, ""):
        return None
    if not isinstance(task_id, str) or get_task(conn, task_id) is None:
        raise Problem(400, "unknown_task", "task_id does not match a task.")
    return task_id


def normalize_calendar(conn: sqlite3.Connection, raw: dict, *, editor: str, settings: Settings, kind: str) -> dict:
    if not isinstance(raw, dict):
        raise Problem(400, "invalid_payload", "Payload must be an object.")
    touches_fixed = False
    if kind == "calendar_block":
        start, end = _span(raw, settings)
        domain = raw.get("domain") or "work"
        if domain not in GENERIC_TITLE:
            raise Problem(400, "invalid_domain", "Domain must be work, home, or personal.")
        event_key = _event_key(raw, required=False)
        fixed = bool(raw.get("fixed")) if editor == "human" else False
        block = None
    else:
        event_key = _event_key(raw, required=True)
        block = get_block(conn, event_key)
        if block is None:
            raise Problem(400, "unknown_block", "No app-owned block has that id. Nothing was changed.")
        domain = block["domain"]
        fixed = bool(block["fixed"])
        if kind == "calendar_cancel":
            start, end = parse_utc(block["starts_at"]), parse_utc(block["ends_at"])
            touches_fixed = fixed
        else:
            if any(key in raw for key in ("starts_at", "ends_at", "starts_local", "ends_local")):
                start, end = _span(raw, settings)
            else:
                start, end = parse_utc(block["starts_at"]), parse_utc(block["ends_at"])
            touches_fixed = fixed and (fmt_utc(start) != block["starts_at"] or fmt_utc(end) != block["ends_at"])
        if editor == "human" and raw.get("domain") in GENERIC_TITLE:
            domain = raw["domain"]
    custom = editor == "human" and raw.get("allow_custom_title") is True and bool(str(raw.get("title") or "").strip())
    if custom:
        title = clean_title(raw.get("title"))
        description = str(raw.get("description") or GENERIC_DESCRIPTION)[:500]
    else:
        title = GENERIC_TITLE[domain]
        description = GENERIC_DESCRIPTION
    invite = bool(raw.get("invite_work_email")) and domain == "work"
    if kind != "calendar_block" and block is not None and "invite_work_email" not in raw:
        invite = bool(block["invite_work_email"])
    return {
        "op": kind,
        "event_key": event_key,
        "task_id": _task_id(conn, raw) if kind == "calendar_block" or raw.get("task_id") else (None if kind == "calendar_block" else block["task_id"] if block else None),
        "title": title,
        "description": description,
        "starts_at": fmt_utc(start),
        "ends_at": fmt_utc(end),
        "domain": domain,
        "invite_work_email": invite,
        "fixed": fixed if kind == "calendar_block" or block is None else bool(block["fixed"]),
        "touches_fixed": touches_fixed,
        "allow_custom_title": bool(custom),
    }


def normalize_task_change(conn: sqlite3.Connection, raw: dict, *, editor: str) -> dict:
    del editor
    if not isinstance(raw, dict):
        raise Problem(400, "invalid_payload", "Payload must be an object.")
    op = raw.get("op") or "update"
    if op == "create":
        task = raw.get("task") if isinstance(raw.get("task"), dict) else raw
        cleaned = {key: task[key] for key in TASK_FIELDS if key in task}
        if "title" not in cleaned or "domain" not in cleaned:
            raise Problem(400, "invalid_task", "A new task needs a title and a domain.")
        return {"op": "create", "task": cleaned}
    if op != "update":
        raise Problem(400, "invalid_payload", "Task proposals must create or update.")
    task_id = raw.get("task_id")
    if not isinstance(task_id, str):
        raise Problem(400, "unknown_task", "task_id is required.")
    current = conn.execute("SELECT version FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if current is None:
        raise Problem(400, "unknown_task", "task_id does not match a task.")
    incoming = raw.get("changes") if isinstance(raw.get("changes"), dict) else {}
    changes = {key: incoming[key] for key in TASK_FIELDS if key in incoming}
    if not changes:
        raise Problem(400, "empty_update", "Task proposal has no allowed changes.")
    return {
        "op": "update",
        "task_id": task_id,
        "changes": changes,
        "base_task_version": current["version"],
    }


def _availability_for(settings: Settings, adapter: CalendarAdapter, payload: dict) -> dict:
    start = parse_utc(payload["starts_at"]) - timedelta(hours=2)
    end = parse_utc(payload["ends_at"]) + timedelta(hours=2)
    return availability_report(settings, adapter, start, end)


def _same_stored_body(existing: sqlite3.Row, kind: str, explanation: str, payload: dict, raw_payload: object) -> bool:
    if existing["kind"] != kind or existing["explanation"] != explanation:
        return False
    stored = json.loads(existing["payload_json"])
    compared = payload
    if kind != "task_change":
        raw = raw_payload if isinstance(raw_payload, dict) else {}
        if not raw.get("event_key") and not raw.get("block_id"):
            stored = dict(stored)
            compared = dict(payload)
            stored.pop("event_key", None)
            compared.pop("event_key", None)
    return stored == compared


def create_proposal(
    settings: Settings,
    adapter: CalendarAdapter,
    data: dict,
    actor: str,
) -> tuple[dict, bool]:
    source_kind = data.get("source_kind") or "human"
    if actor == "agent":
        source_kind = "agent"
    elif source_kind == "agent":
        raise Problem(400, "actor_mismatch", "Agent proposals must send the header X-TAFO-Actor: agent.")
    if source_kind not in {"agent", "human"}:
        raise Problem(400, "bad_actor", "source_kind must be agent or human.")
    source = str(data.get("source") or "").strip()
    if not source or len(source) > 80:
        raise Problem(400, "invalid_source", "Source must be 1–80 characters.")
    explanation = str(data.get("explanation") or "").strip()
    if not explanation or len(explanation) > 2000:
        raise Problem(400, "invalid_explanation", "Explanation must be 1–2000 characters.")
    kind = data.get("kind")
    if kind not in {"task_change", "calendar_block", "calendar_update", "calendar_cancel"}:
        raise Problem(400, "invalid_kind", "Unsupported proposal kind.")
    idem = data.get("idempotency_key")
    if idem is not None:
        if not isinstance(idem, str) or not IDEM_RE.fullmatch(idem):
            raise Problem(400, "bad_idempotency_key", "idempotency_key has an unsupported shape.")
    if source_kind == "agent" and not idem:
        raise Problem(400, "idempotency_required", "Agent proposals require idempotency_key so retries do not duplicate work.")
    raw_payload = data.get("payload")
    with read_session(settings.db_path) as conn:
        if kind == "task_change":
            payload = normalize_task_change(conn, raw_payload, editor=source_kind)
        else:
            payload = normalize_calendar(conn, raw_payload, editor=source_kind, settings=settings, kind=kind)
        if idem:
            existing = conn.execute("SELECT * FROM proposals WHERE idempotency_key = ?", (idem,)).fetchone()
            if existing is not None:
                if not _same_stored_body(existing, kind, explanation, payload, raw_payload):
                    raise Problem(
                        409,
                        "idempotency_conflict",
                        "This idempotency_key was already used with a different body.",
                    )
                return serialize_proposal(existing), True
    if kind == "task_change":
        availability = None
        target_task = payload.get("task_id")
        target_block = None
    else:
        availability = _availability_for(settings, adapter, payload)
        target_task = payload.get("task_id")
        target_block = payload.get("event_key")
    proposal_id = new_id("prp")
    now = utc_now_iso()
    with session(settings.db_path) as conn:
        if idem:
            existing = conn.execute("SELECT * FROM proposals WHERE idempotency_key = ?", (idem,)).fetchone()
            if existing is not None:
                if not _same_stored_body(existing, kind, explanation, payload, raw_payload):
                    raise Problem(
                        409,
                        "idempotency_conflict",
                        "This idempotency_key was already used with a different body.",
                    )
                return serialize_proposal(existing), True
        try:
            conn.execute(
                """
                INSERT INTO proposals (
                  id, source, source_kind, kind, status, explanation, payload_json, edited_payload_json,
                  target_task_id, target_block_id, availability_json, idempotency_key, version,
                  decision_note, decided_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)
                """,
                (
                    proposal_id,
                    source,
                    source_kind,
                    kind,
                    explanation,
                    json.dumps(payload),
                    target_task,
                    target_block,
                    None if availability is None else json.dumps(availability),
                    idem,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            existing = None
            if idem:
                existing = conn.execute("SELECT * FROM proposals WHERE idempotency_key = ?", (idem,)).fetchone()
            if existing is not None and _same_stored_body(existing, kind, explanation, payload, raw_payload):
                return serialize_proposal(existing), True
            if existing is not None:
                raise Problem(
                    409,
                    "idempotency_conflict",
                    "This idempotency_key was already used with a different body.",
                ) from exc
            raise
        write_audit(
            conn,
            actor=f"agent:{source}" if source_kind == "agent" else "human",
            action="proposal.create",
            entity_type="proposal",
            entity_id=proposal_id,
            detail={"kind": kind},
        )
        created = get_proposal(conn, proposal_id)
        assert created is not None
        return created, False


def edit_proposal(
    settings: Settings,
    adapter: CalendarAdapter,
    proposal_id: str,
    *,
    expected_version: int,
    payload: dict,
    actor: str,
) -> dict:
    with read_session(settings.db_path) as conn:
        row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
        if row is None:
            raise Problem(404, "not_found", "Proposal not found.")
        if row["status"] != "pending":
            raise Problem(409, "not_pending", "Only a pending proposal can be edited.")
        if row["version"] != expected_version:
            raise Problem(409, "version_conflict", "This proposal changed.", current_version=row["version"])
        kind = row["kind"]
        if kind == "task_change":
            normalized = normalize_task_change(conn, payload, editor="human")
        else:
            normalized = normalize_calendar(conn, payload, editor="human", settings=settings, kind=kind)
    if kind == "task_change":
        availability = None
        target_task = normalized.get("task_id")
        target_block = None
    else:
        availability = _availability_for(settings, adapter, normalized)
        target_task = normalized.get("task_id")
        target_block = normalized.get("event_key")
    now = utc_now_iso()
    with session(settings.db_path) as conn:
        cursor = conn.execute(
            """
            UPDATE proposals
            SET edited_payload_json = ?, availability_json = ?, target_task_id = ?, target_block_id = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND status = 'pending'
            """,
            (
                json.dumps(normalized),
                None if availability is None else json.dumps(availability),
                target_task,
                target_block,
                now,
                proposal_id,
                expected_version,
            ),
        )
        if cursor.rowcount != 1:
            raise Problem(409, "version_conflict", "This proposal changed.")
        write_audit(conn, actor=actor, action="proposal.edit", entity_type="proposal", entity_id=proposal_id, detail={})
        updated = get_proposal(conn, proposal_id)
        assert updated is not None
        return updated


def reject_proposal(
    conn: sqlite3.Connection,
    proposal_id: str,
    *,
    expected_version: int,
    note: str,
    actor: str,
) -> dict:
    row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Proposal not found.")
    if row["status"] != "pending":
        raise Problem(409, "not_pending", "Only a pending proposal can be rejected.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This proposal changed.", current_version=row["version"])
    now = utc_now_iso()
    cursor = conn.execute(
        """
        UPDATE proposals
        SET status = 'rejected', version = version + 1, decision_note = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'pending'
        """,
        (note[:500], now, now, proposal_id, expected_version),
    )
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This proposal changed.")
    write_audit(conn, actor=actor, action="proposal.reject", entity_type="proposal", entity_id=proposal_id, detail={})
    updated = get_proposal(conn, proposal_id)
    assert updated is not None
    return updated


def _apply_task(conn: sqlite3.Connection, payload: dict, acknowledge_task_drift: bool, actor: str) -> None:
    if payload["op"] == "create":
        create_task(conn, payload["task"], actor=actor)
        return
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (payload["task_id"],)).fetchone()
    if row is None:
        raise Problem(409, "unknown_task", "The task no longer exists. Nothing was applied.")
    if row["version"] != payload["base_task_version"] and not acknowledge_task_drift:
        raise Problem(
            409,
            "task_version_conflict",
            "The task changed after this proposal was written. Nothing was applied.",
            current_version=row["version"],
            base_task_version=payload["base_task_version"],
        )
    expected = row["version"] if acknowledge_task_drift else payload["base_task_version"]
    update_task(conn, payload["task_id"], payload["changes"], expected, actor=actor)


def stage_approval(
    conn: sqlite3.Connection,
    settings: Settings,
    proposal_id: str,
    *,
    expected_version: int,
    note: str,
    acknowledge_fixed_move: bool,
    acknowledge_task_drift: bool,
    actor: str,
) -> dict:
    row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Proposal not found.")
    if row["status"] == "approved":
        existing = outbox_for_proposal(conn, proposal_id)
        return {
            "replay": True,
            "proposal": serialize_proposal(row),
            "outbox_id": None if existing is None else existing["id"],
            "outbox_status": None if existing is None else existing["status"],
        }
    if row["status"] != "pending":
        raise Problem(409, "not_pending", "Only a pending proposal can be approved.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This proposal changed.", current_version=row["version"])
    payload = effective_payload(row)
    if payload.get("touches_fixed") and not acknowledge_fixed_move:
        raise Problem(
            409,
            "fixed_block_requires_acknowledgement",
            "This proposal changes a fixed appointment. Nothing was moved. "
            "Send acknowledge_fixed_move true only when you intend that change.",
        )
    if row["kind"] == "task_change" and payload.get("op") == "update":
        current = conn.execute("SELECT version FROM tasks WHERE id = ?", (payload["task_id"],)).fetchone()
        if current and current["version"] != payload["base_task_version"] and not acknowledge_task_drift:
            raise Problem(
                409,
                "task_version_conflict",
                "The task changed after this proposal was written. Nothing was applied.",
                current_version=current["version"],
                base_task_version=payload["base_task_version"],
            )
    now = utc_now_iso()
    cursor = conn.execute(
        """
        UPDATE proposals
        SET status = 'approved', version = version + 1, decision_note = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'pending'
        """,
        (note[:500], now, now, proposal_id, expected_version),
    )
    if cursor.rowcount != 1:
        current = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
        if current is not None and current["status"] == "approved":
            existing = outbox_for_proposal(conn, proposal_id)
            return {
                "replay": True,
                "proposal": serialize_proposal(current),
                "outbox_id": None if existing is None else existing["id"],
                "outbox_status": None if existing is None else existing["status"],
            }
        raise Problem(409, "version_conflict", "This proposal changed.")
    outbox_id = None
    if row["kind"] == "task_change":
        _apply_task(conn, payload, acknowledge_task_drift, actor)
    else:
        outbox_id = ensure_outbox(conn, proposal_id, row["kind"], payload, settings.calendar_mode)
    write_audit(
        conn,
        actor=actor,
        action="proposal.approve",
        entity_type="proposal",
        entity_id=proposal_id,
        detail={"kind": row["kind"], "outbox_id": outbox_id},
    )
    fresh = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    return {
        "replay": False,
        "proposal": serialize_proposal(fresh),
        "outbox_id": outbox_id,
        "outbox_status": "pending" if outbox_id else None,
    }


def _insert_human_update(
    conn: sqlite3.Connection,
    *,
    explanation: str,
    idempotency_key: str,
    payload: dict,
    raw_payload: dict,
) -> tuple[str, int, bool]:
    """Insert one pending human calendar_update. Returns id, version, and whether it already existed."""
    existing = conn.execute(
        "SELECT * FROM proposals WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()
    if existing is not None:
        if not _same_stored_body(existing, "calendar_update", explanation, payload, raw_payload):
            raise Problem(409, "idempotency_conflict", "This idempotency_key was already used with a different body.")
        return existing["id"], int(existing["version"]), True
    proposal_id = new_id("prp")
    now = utc_now_iso()
    conn.execute(
        """
        INSERT INTO proposals (
          id, source, source_kind, kind, status, explanation, payload_json, edited_payload_json,
          target_task_id, target_block_id, availability_json, idempotency_key, version,
          decision_note, decided_at, created_at, updated_at
        ) VALUES (?, 'plan', 'human', 'calendar_update', 'pending', ?, ?, NULL, ?, ?, NULL, ?, 1, NULL, NULL, ?, ?)
        """,
        (
            proposal_id,
            explanation,
            json.dumps(payload),
            payload.get("task_id"),
            payload.get("event_key"),
            idempotency_key,
            now,
            now,
        ),
    )
    write_audit(
        conn,
        actor="human",
        action="proposal.create",
        entity_type="proposal",
        entity_id=proposal_id,
        detail={"kind": "calendar_update"},
    )
    return proposal_id, 1, False


def _retime_proposal(
    conn: sqlite3.Connection,
    settings: Settings,
    proposal_id: str,
    expected_version: int,
    starts_at: str,
    ends_at: str,
) -> int:
    """Move a pending proposal inside the open transaction. Returns the new version."""
    row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise Problem(404, "not_found", "Proposal not found.")
    if row["status"] != "pending":
        raise Problem(409, "not_pending", "Only a pending proposal can be edited.")
    if row["version"] != expected_version:
        raise Problem(409, "version_conflict", "This proposal changed.", current_version=row["version"])
    current = effective_payload(row)
    raw = {
        "event_key": current.get("event_key"),
        "task_id": current.get("task_id"),
        "domain": current.get("domain"),
        "starts_at": starts_at,
        "ends_at": ends_at,
        "title": current.get("title"),
        "allow_custom_title": current.get("allow_custom_title"),
        "fixed": current.get("fixed"),
        "invite_work_email": current.get("invite_work_email"),
    }
    normalized = normalize_calendar(conn, raw, editor="human", settings=settings, kind=row["kind"])
    now = utc_now_iso()
    cursor = conn.execute(
        """
        UPDATE proposals
        SET edited_payload_json = ?, target_task_id = ?, target_block_id = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'pending'
        """,
        (
            json.dumps(normalized),
            normalized.get("task_id"),
            normalized.get("event_key"),
            now,
            proposal_id,
            expected_version,
        ),
    )
    if cursor.rowcount != 1:
        raise Problem(409, "version_conflict", "This proposal changed.")
    write_audit(conn, actor="human", action="proposal.edit", entity_type="proposal", entity_id=proposal_id, detail={})
    return expected_version + 1


def commit_plan(
    conn: sqlite3.Connection,
    settings: Settings,
    *,
    moves: list[dict],
    approvals: list[dict],
    actor: str,
) -> dict:
    """Approve every staged move and included proposal, or apply none of them.

    The caller owns the transaction. Outbox rows are queued here and processed
    after commit, the same way a single approval is.
    """
    if not moves and not approvals:
        raise Problem(400, "empty_plan", "Nothing to approve.")
    staged_moves = []
    for move in moves:
        block = get_block(conn, move["block_id"])
        if block is None:
            raise Problem(400, "unknown_block", "No app-owned block has that id. Nothing was changed.")
        raw = {
            "event_key": move["block_id"],
            "task_id": block["task_id"],
            "starts_at": move["starts_at"],
            "ends_at": move["ends_at"],
            "allow_custom_title": True,
            "title": move["title"],
            "timezone": settings.display_timezone,
        }
        payload = normalize_calendar(conn, raw, editor="human", settings=settings, kind="calendar_update")
        explanation = f"Moved {move['title']} in plan mode."
        existing = conn.execute(
            "SELECT id FROM proposals WHERE idempotency_key = ?",
            (move["idempotency_key"],),
        ).fetchone()
        if existing is None and block["version"] != move["expected_version"]:
            raise Problem(409, "version_conflict", "This block changed. Nothing was changed.", current_version=block["version"])
        proposal_id, version, replay_insert = _insert_human_update(
            conn,
            explanation=explanation,
            idempotency_key=move["idempotency_key"],
            payload=payload,
            raw_payload=raw,
        )
        staged = stage_approval(
            conn,
            settings,
            proposal_id,
            expected_version=version,
            note="",
            acknowledge_fixed_move=bool(move.get("acknowledge_fixed_move")),
            acknowledge_task_drift=False,
            actor=actor,
        )
        staged_moves.append({**staged, "inserted_replay": replay_insert})

    staged_approvals = []
    for approval in approvals:
        version = int(approval["expected_version"])
        if approval.get("starts_at") and approval.get("ends_at"):
            version = _retime_proposal(
                conn,
                settings,
                approval["proposal_id"],
                version,
                approval["starts_at"],
                approval["ends_at"],
            )
        staged_approvals.append(
            stage_approval(
                conn,
                settings,
                approval["proposal_id"],
                expected_version=version,
                note="",
                acknowledge_fixed_move=False,
                acknowledge_task_drift=False,
                actor=actor,
            )
        )
    return {"moves": staged_moves, "approvals": staged_approvals}
