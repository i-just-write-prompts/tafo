"""Fictional sample data so a first local run is not an empty screen."""

from __future__ import annotations

import sqlite3
from datetime import timedelta
from zoneinfo import ZoneInfo

from tafo.calendar_adapter import DEMO_HONEST_LABEL, CalendarAdapter
from tafo.config import Settings
from tafo.decisions import create_proposal
from tafo.demo_schedule import DEMO_MIRROR_KEY, demo_fixed_span, demo_mirror_span
from tafo.tasks import add_subtask, create_task, update_subtask
from tafo.timeutil import fmt_utc, utc_now, utc_now_iso


def _insert_block(
    conn: sqlite3.Connection,
    *,
    block_id: str,
    task_id: str | None,
    start,
    end,
    domain: str,
    fixed: bool,
) -> None:
    now = utc_now_iso()
    title = {"work": "Focus block", "home": "Home block", "personal": "Personal block"}[domain]
    conn.execute(
        """
        INSERT INTO calendar_blocks (
          id, task_id, origin_proposal_id, title, description, starts_at, ends_at, domain,
          invite_work_email, fixed, status, sync_state, written_mode, honest_label,
          google_event_id, version, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, 'scheduled', 'simulated', 'demo', ?, NULL, 1, ?, ?)
        """,
        (
            block_id,
            task_id,
            title,
            "Time block created by TAFO.",
            fmt_utc(start),
            fmt_utc(end),
            domain,
            1 if fixed else 0,
            DEMO_HONEST_LABEL,
            now,
            now,
        ),
    )


def seed_if_empty(conn: sqlite3.Connection, settings: Settings, adapter: CalendarAdapter) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
    if count:
        return
    today = utc_now().astimezone(ZoneInfo(settings.display_timezone)).date()

    def due(days: int) -> str:
        return (today + timedelta(days=days)).isoformat()

    create_task(
        conn,
        {
            "id": "task_seed_kickoff",
            "title": "Outline the Northwind sample kickoff",
            "domain": "work",
            "status": "todo",
            "estimate_hours": 1.5,
            "due_date": due(1),
            "notes": "Fictional sample. A calendar block for this stays on a generic title unless you edit the proposal.",
            "on_today": True,
            "sort_order": 10,
        },
        actor="human",
    )
    create_task(
        conn,
        {
            "id": "task_seed_booth",
            "title": "Compare two notepad sketches for the booth layout",
            "domain": "work",
            "status": "doing",
            "estimate_hours": 2,
            "notes": "Sample checklist only.",
            "on_today": True,
            "sort_order": 20,
        },
        actor="human",
    )
    first = add_subtask(conn, "task_seed_booth", "Sketch the north wall", actor="human")
    update_subtask(conn, first["id"], {"done": True}, first["version"], actor="human")
    add_subtask(conn, "task_seed_booth", "Sketch the south wall", actor="human")
    create_task(
        conn,
        {
            "id": "task_seed_drills",
            "title": "Block a quiet hour for language drills",
            "domain": "personal",
            "estimate_hours": 1,
            "on_today": True,
            "sort_order": 30,
        },
        actor="human",
    )
    create_task(
        conn,
        {
            "id": "task_seed_faucet",
            "title": "Replace the practice-kitchen faucet washer",
            "domain": "home",
            "estimate_hours": 0.75,
            "notes": "Sample home task. It stays in the backlog until you move it or approve the sample proposal.",
            "on_today": False,
            "sort_order": 40,
        },
        actor="human",
    )
    create_task(
        conn,
        {
            "id": "task_seed_library",
            "title": "Return the library book Harbor Signals",
            "domain": "personal",
            "status": "waiting",
            "estimate_hours": 0.25,
            "due_date": due(5),
            "on_today": False,
            "sort_order": 50,
        },
        actor="human",
    )
    create_task(
        conn,
        {
            "id": "task_seed_envelope",
            "title": "File the sample expense envelope",
            "domain": "work",
            "status": "done",
            "estimate_hours": 0.5,
            "on_today": True,
            "sort_order": 60,
        },
        actor="human",
    )
    started = fmt_utc(utc_now() - timedelta(minutes=20))
    conn.execute(
        "INSERT INTO timer_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, ?)",
        ("tim_seed_envelope", "task_seed_envelope", started, utc_now_iso()),
    )
    mirror_start, mirror_end = demo_mirror_span()
    fixed_start, fixed_end = demo_fixed_span()
    _insert_block(
        conn,
        block_id=DEMO_MIRROR_KEY,
        task_id="task_seed_drills",
        start=mirror_start,
        end=mirror_end,
        domain="personal",
        fixed=False,
    )
    _insert_block(
        conn,
        block_id="block_seed_fixed",
        task_id=None,
        start=fixed_start,
        end=fixed_end,
        domain="personal",
        fixed=True,
    )
    proposal_start = fixed_start + timedelta(hours=4)
    proposal_end = proposal_start + timedelta(minutes=90)
    create_proposal(
        conn,
        adapter,
        settings,
        {
            "source": "tafo-sample",
            "source_kind": "human",
            "kind": "calendar_block",
            "explanation": (
                "Sample proposal: hold a generic focus block for the Northwind kickoff outline. "
                "Approving queues one simulated calendar operation. Outlook meetings are still invisible."
            ),
            "idempotency_key": "seed-calendar-kickoff",
            "payload": {
                "task_id": "task_seed_kickoff",
                "domain": "work",
                "starts_at": fmt_utc(proposal_start),
                "ends_at": fmt_utc(proposal_end),
                "invite_work_email": False,
            },
        },
        "human",
    )
    create_proposal(
        conn,
        adapter,
        settings,
        {
            "source": "tafo-sample",
            "source_kind": "human",
            "kind": "task_change",
            "explanation": "Sample proposal: move the faucet washer onto Today. Nothing changes until you approve it.",
            "idempotency_key": "seed-task-faucet",
            "payload": {
                "op": "update",
                "task_id": "task_seed_faucet",
                "changes": {"on_today": True},
            },
        },
        "human",
    )
