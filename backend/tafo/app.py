"""TAFO HTTP API."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from tafo import __version__
from tafo.audit import list_audit
from tafo.availability import availability_report, suggest_slot
from tafo.backup import export_snapshot, restore_snapshot, write_backup_file
from tafo.blocks import get_block, list_blocks
from tafo.calendar_adapter import OUTLOOK_GAP, CalendarAdapter, build_adapter
from tafo.config import Settings, host_is_loopback
from tafo.db import connect, read_session, session
from tafo.decisions import (
    create_proposal,
    edit_proposal,
    get_proposal,
    list_proposals,
    reject_proposal,
    stage_approval,
)
from tafo.migrate import apply_migrations
from tafo.outbox import list_outbox, process_outbox, serialize_outbox
from tafo.problems import Problem
from tafo.schemas import (
    DecisionBody,
    EditBody,
    ProposalCreate,
    RestoreBody,
    SubtaskCreate,
    SubtaskPatch,
    TaskCreate,
    TaskDelete,
    TaskMove,
    TaskPatch,
    WeekRegenerate,
    WeekSave,
)
from tafo.seed import seed_if_empty
from tafo.tasks import (
    active_timer,
    add_subtask,
    create_task,
    delete_subtask,
    delete_task,
    get_task,
    list_tasks,
    move_task,
    start_timer,
    stop_timer,
    update_subtask,
    update_task,
)
from datetime import timedelta

from tafo.timeutil import parse_utc, utc_now
from tafo.ui_session import UiSession
from tafo.week import get_week, regenerate_week, save_week

DESCRIPTION = """
Personal-first task list and time blocking for one person on localhost.

**Hermes inbox.** `POST /api/hermes/proposals` is the only agent write. It stores a proposal and an explanation. It does not change tasks or calendars. Agents identify themselves with `X-TAFO-Actor: agent` and must send an `idempotency_key`.

**Human decisions.** Approve, edit, and reject live at `/api/decisions/{id}/...`. The caller must send `confirmed: true` and must not send `X-TAFO-Actor: agent`. Approving a calendar proposal inserts one outbox operation. Approving the same proposal again returns that operation and does not insert another. `POST /api/calendar/outbox/{id}/retry` reuses the same event key.

**Demo and live.** Default `TAFO_CALENDAR_MODE=demo` simulates blocks and labels them as not synced. Live mode uses Google Calendar as the write authority for app-owned blocks. Missing credentials fail closed. Work invitations use the configured work address only; the proposal cannot name an address. Invite-only delivery does not reveal Outlook meetings, so availability is never conflict-free.

**Not a security boundary.** Work / Life / All are view filters. Manager access is deferred (HTTP 501). Do not expose this port beyond loopback.

**Clock.** Instants are stored in UTC. Due dates are calendar dates. The display timezone defaults to America/Indianapolis.
""".strip()

NOTICES = [
    "Work and Life are view filters, not security boundaries. Manager access is deferred.",
    "Get employer permission before storing work information here or writing work details to a personal Google calendar.",
    "Calendar titles default to generic labels. An invitation does not bypass workplace policy.",
    OUTLOOK_GAP,
]


def init_db(settings: Settings, adapter: CalendarAdapter) -> None:
    conn = connect(settings.db_path)
    pending: list[dict] = []
    try:
        apply_migrations(conn)
        if settings.seed_demo:
            conn.execute("BEGIN IMMEDIATE")
            try:
                pending = seed_if_empty(conn, settings, adapter)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
    finally:
        conn.close()
    for body in pending:
        create_proposal(settings, adapter, body, "human")


def _actor(request: Request) -> str:
    raw = request.headers.get("x-tafo-actor", "human").strip().lower()
    if raw not in {"human", "agent"}:
        raise Problem(400, "bad_actor", "X-TAFO-Actor must be human or agent when it is sent.")
    return raw


def _require_human(request: Request) -> str:
    actor = _actor(request)
    if actor == "agent":
        raise Problem(
            403,
            "agent_cannot_mutate",
            "Agents may only submit proposals to POST /api/hermes/proposals. "
            "They cannot change tasks, timers, summaries, backups, calendars, or decisions.",
        )
    return "human"


def _require_confirmed(confirmed: bool) -> None:
    if not confirmed:
        raise Problem(400, "confirmation_required", "Set confirmed true. Nothing was changed.")


def _require_decision(request: Request) -> str:
    """Approve, deny, and edit. A missing actor is not a person, and a header is not a session."""
    raw = request.headers.get("x-tafo-actor")
    if raw is None or not raw.strip():
        raise Problem(
            403,
            "ui_session_required",
            "Approve, deny, and edit are only accepted from the local UI session.",
        )
    _require_human(request)
    UiSession.accept(request)
    return "human"


def _finish(settings: Settings, adapter: CalendarAdapter, staged: dict) -> dict:
    outbox = None
    block = None
    outbox_id = staged.get("outbox_id")
    if outbox_id and staged.get("outbox_status") not in {"simulated", "synced"}:
        outbox = process_outbox(settings, adapter, outbox_id)
    elif outbox_id:
        with session(settings.db_path) as conn:
            row = conn.execute("SELECT * FROM outbox_operations WHERE id = ?", (outbox_id,)).fetchone()
            outbox = None if row is None else serialize_outbox(row)
    if outbox is not None:
        with session(settings.db_path) as conn:
            block = get_block(conn, outbox["event_key"])
    return {
        "proposal": staged["proposal"],
        "outbox": outbox,
        "block": block,
        "idempotent_replay": bool(staged["replay"]),
    }


def create_app(settings: Settings | None = None, adapter: CalendarAdapter | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate()
    if adapter is None:
        adapter = build_adapter(settings)
    ui_session_token = UiSession.mint()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        init_db(settings, adapter)
        if settings.calendar_mode == "demo":
            print("TAFO calendar mode: demo. Blocks are simulated and NOT synced to Google.")
        elif settings.google_configured:
            print("TAFO calendar mode: live. Google Calendar is the write authority for app-owned blocks.")
        else:
            print("TAFO calendar mode: live, but credentials are missing. Writes fail closed and are NOT synced.")
        if settings.allow_lan:
            print("WARNING: TAFO_ALLOW_LAN=1. This API has no user authentication.")
        yield

    app = FastAPI(
        title="TAFO",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
        servers=[{"url": "http://127.0.0.1:8787", "description": "Loopback"}],
    )
    app.state.settings = settings
    app.state.adapter = adapter
    app.state.ui_session_token = ui_session_token
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:5174",
            "http://localhost:5174",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def require_loopback_host(request: Request, call_next):
        if not settings.allow_lan and not host_is_loopback(request.headers.get("host")):
            return JSONResponse(
                status_code=400,
                content={
                    "detail": {
                        "code": "bad_host",
                        "message": "TAFO only accepts a loopback Host header (127.0.0.1, localhost, or ::1).",
                    }
                },
            )
        return await call_next(request)

    @app.middleware("http")
    async def issue_ui_cookie(request: Request, call_next):
        response = await call_next(request)
        if response.status_code == 200 and UiSession.should_issue(request):
            response.headers.append("set-cookie", UiSession.cookie_header(request.app.state.ui_session_token))
        return response

    @app.exception_handler(Problem)
    async def problem_handler(_request: Request, exc: Problem) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"detail": {"code": exc.code, "message": exc.message, **exc.extra}},
        )

    @app.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {"ok": True, "service": "tafo"}

    @app.get("/api/meta", tags=["meta"])
    def meta() -> dict:
        if settings.calendar_mode == "demo":
            sync_label = "Demo dry-run — NOT synced to Google Calendar"
        elif settings.google_configured:
            sync_label = "Live mode — Google Calendar is the write authority"
        else:
            sync_label = "Live mode is not configured — writes fail closed and are NOT synced"
        return {
            "name": "TAFO",
            "version": __version__,
            "tagline": "Task around & find out",
            "calendar_mode": settings.calendar_mode,
            "sync_label": sync_label,
            "display_timezone": settings.display_timezone,
            "google_configured": settings.calendar_mode == "live" and settings.google_configured,
            "work_invite_configured": bool(settings.work_invite_email),
            "manager_access": "deferred",
            "bind_host": settings.host,
            "outlook_gap": OUTLOOK_GAP,
            "notices": NOTICES,
            "filter_note": "Work, Life, and All are view filters. They are not a security boundary.",
            "human_edits_auto_approve": settings.human_edits_auto_approve,
        }

    @app.get("/api/hermes/contract", tags=["hermes"])
    def hermes_contract() -> dict:
        return {
            "name": "TAFO Hermes proposal inbox",
            "submit": "POST /api/hermes/proposals",
            "read": ["GET /api/hermes/proposals", "GET /api/hermes/proposals/{proposal_id}"],
            "decide": [
                "POST /api/decisions/{proposal_id}/approve",
                "POST /api/decisions/{proposal_id}/edit",
                "POST /api/decisions/{proposal_id}/reject",
            ],
            "rules": [
                "Submitting a proposal does not change tasks or calendar blocks.",
                "Agents cannot call decision routes. Send X-TAFO-Actor: agent only when submitting.",
                "Agent retries must reuse idempotency_key.",
                "Calendar titles from agents are replaced with generic titles.",
                "invite_work_email is a boolean. The work address comes from TAFO_WORK_INVITE_EMAIL, not the payload.",
                "Approving a calendar proposal creates one outbox row. A second approval returns it.",
                "Retry uses the same event key so a Google upsert does not insert a duplicate.",
                "Demo results are simulated and are not labeled as synced.",
                "Availability always includes the Outlook blind spot. TAFO does not promise a conflict-free schedule.",
                "Fixed appointments are not moved unless a person approves with acknowledge_fixed_move.",
            ],
        }

    @app.get("/api/tasks", tags=["tasks"])
    def get_tasks(view: str = "all", scope: str = "all") -> dict:
        with session(settings.db_path) as conn:
            tasks = list_tasks(conn, view, scope)
        return {
            "view": view,
            "scope": scope,
            "filter_only": True,
            "authorization": "none",
            "note": "Work, Life, and All are view filters. They are not a security boundary.",
            "tasks": tasks,
        }

    @app.post("/api/tasks", status_code=201, tags=["tasks"])
    def post_task(body: TaskCreate, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return create_task(conn, body.model_dump(), actor="human")

    @app.get("/api/tasks/{task_id}", tags=["tasks"])
    def get_one_task(task_id: str) -> dict:
        with session(settings.db_path) as conn:
            task = get_task(conn, task_id)
        if task is None:
            raise Problem(404, "not_found", "Task not found.")
        return task

    @app.patch("/api/tasks/{task_id}", tags=["tasks"])
    def patch_task(task_id: str, body: TaskPatch, request: Request) -> dict:
        _require_human(request)
        data = body.model_dump(exclude_unset=True)
        expected = data.pop("expected_version")
        with session(settings.db_path) as conn:
            return update_task(conn, task_id, data, expected, actor="human")

    @app.post("/api/tasks/{task_id}/move", tags=["tasks"])
    def post_move(task_id: str, body: TaskMove, request: Request) -> dict:
        """Reorder one task inside a view.

        Body: direction `up` or `down`, view `all` | `work` | `life`, scope `all` | `today` | `backlog`,
        and `expected_version` from the task you loaded. Humans only (`X-TAFO-Actor: agent` is 403).
        200 returns the task. A move that is already at the end of that list changes nothing, but a
        stale `expected_version` is still 409 `version_conflict` and the order stays. 404 if the task
        is missing or not in that view.
        """
        _require_human(request)
        with session(settings.db_path) as conn:
            return move_task(
                conn,
                task_id,
                direction=body.direction,
                view=body.view,
                scope=body.scope,
                expected_version=body.expected_version,
                actor="human",
            )

    @app.post("/api/tasks/{task_id}/delete", tags=["tasks"])
    def post_delete_task(task_id: str, body: TaskDelete, request: Request) -> dict:
        """Delete one task and cancel its scheduled calendar blocks.

        Body: `{"expected_version": <int>}` from the task you loaded. Humans only.
        200 deletes the task, its checklist items, and its timer rows, and processes a cancel
        outbox row for each scheduled block (a stored Google event is removed by that cancel).
        409 `version_conflict` leaves the task and its events in place.
        """
        _require_human(request)
        with session(settings.db_path) as conn:
            cancel_ids = delete_task(
                conn,
                task_id,
                body.expected_version,
                actor="human",
                calendar_mode=settings.calendar_mode,
            )
        cancellations = [process_outbox(settings, adapter, outbox_id) for outbox_id in cancel_ids]
        return {"deleted": True, "id": task_id, "cancellations": cancellations}

    @app.post("/api/tasks/{task_id}/subtasks", status_code=201, tags=["tasks"])
    def post_subtask(task_id: str, body: SubtaskCreate, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return add_subtask(conn, task_id, body.title, actor="human")

    @app.patch("/api/subtasks/{subtask_id}", tags=["tasks"])
    def patch_subtask(subtask_id: str, body: SubtaskPatch, request: Request) -> dict:
        _require_human(request)
        data = body.model_dump(exclude_unset=True)
        expected = data.pop("expected_version")
        with session(settings.db_path) as conn:
            return update_subtask(conn, subtask_id, data, expected, actor="human")

    @app.delete("/api/subtasks/{subtask_id}", tags=["tasks"])
    def remove_subtask(subtask_id: str, request: Request, expected_version: int) -> dict:
        """Delete one checklist item.

        Query: `expected_version` from the item you loaded. Humans only.
        200 removes that item. 409 `version_conflict` leaves it in place.
        """
        _require_human(request)
        with session(settings.db_path) as conn:
            delete_subtask(conn, subtask_id, expected_version, actor="human")
        return {"deleted": True, "id": subtask_id}

    @app.get("/api/timers/active", tags=["timers"])
    def get_active_timer() -> dict:
        with session(settings.db_path) as conn:
            return {"active": active_timer(conn)}

    @app.post("/api/tasks/{task_id}/timer/start", tags=["timers"])
    def post_timer_start(task_id: str, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return start_timer(conn, task_id, actor="human")

    @app.post("/api/tasks/{task_id}/timer/stop", tags=["timers"])
    def post_timer_stop(task_id: str, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return stop_timer(conn, task_id, actor="human")

    @app.get("/api/week", tags=["week"])
    def read_week(week_start: str | None = None) -> dict:
        with session(settings.db_path) as conn:
            return get_week(conn, settings, week_start)

    @app.put("/api/week", tags=["week"])
    def put_week(body: WeekSave, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return save_week(conn, settings, body.week_start, body.bullets, body.expected_version, actor="human")

    @app.post("/api/week/regenerate", tags=["week"])
    def post_week(body: WeekRegenerate, request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return regenerate_week(conn, settings, body.week_start, body.expected_version, actor="human")

    @app.post("/api/hermes/proposals", tags=["hermes"])
    def post_proposal(body: ProposalCreate, request: Request):
        actor = _actor(request)
        proposal, replay = create_proposal(settings, adapter, body.model_dump(), actor)
        return JSONResponse(proposal, status_code=200 if replay else 201)

    @app.get("/api/hermes/proposals", tags=["hermes"])
    def get_proposals(status: str | None = None) -> dict:
        with session(settings.db_path) as conn:
            return {"proposals": list_proposals(conn, status)}

    @app.get("/api/hermes/proposals/{proposal_id}", tags=["hermes"])
    def get_one_proposal(proposal_id: str) -> dict:
        with session(settings.db_path) as conn:
            proposal = get_proposal(conn, proposal_id)
        if proposal is None:
            raise Problem(404, "not_found", "Proposal not found.")
        return proposal

    @app.api_route(
        "/api/hermes/proposals/{proposal_id}/{action}",
        methods=["POST", "PUT", "PATCH"],
        tags=["hermes"],
    )
    def hermes_cannot_decide(proposal_id: str, action: str) -> None:
        del proposal_id
        if action not in {"approve", "reject", "edit"}:
            raise Problem(404, "not_found", "That Hermes action does not exist.")
        raise Problem(
            403,
            "approval_required",
            "The Hermes inbox cannot approve, edit, or reject. A person decides at /api/decisions/{proposal_id}.",
        )

    @app.post("/api/decisions/{proposal_id}/approve", tags=["decisions"])
    def post_approve(proposal_id: str, body: DecisionBody, request: Request) -> dict:
        _require_decision(request)
        _require_confirmed(body.confirmed)
        with session(settings.db_path) as conn:
            staged = stage_approval(
                conn,
                settings,
                proposal_id,
                expected_version=body.expected_version,
                note=body.note,
                acknowledge_fixed_move=body.acknowledge_fixed_move,
                acknowledge_task_drift=body.acknowledge_task_drift,
                actor="human",
            )
        return _finish(settings, adapter, staged)

    @app.post("/api/decisions/{proposal_id}/edit", tags=["decisions"])
    def post_edit(proposal_id: str, body: EditBody, request: Request) -> dict:
        _require_decision(request)
        _require_confirmed(body.confirmed)
        return edit_proposal(
            settings,
            adapter,
            proposal_id,
            expected_version=body.expected_version,
            payload=body.payload,
            actor="human",
        )

    @app.post("/api/decisions/{proposal_id}/reject", tags=["decisions"])
    def post_reject(proposal_id: str, body: DecisionBody, request: Request) -> dict:
        _require_decision(request)
        _require_confirmed(body.confirmed)
        with session(settings.db_path) as conn:
            return reject_proposal(
                conn,
                proposal_id,
                expected_version=body.expected_version,
                note=body.note,
                actor="human",
            )

    @app.get("/api/calendar/blocks", tags=["calendar"])
    def get_blocks() -> dict:
        with session(settings.db_path) as conn:
            return {"blocks": list_blocks(conn), "calendar_mode": settings.calendar_mode}

    @app.get("/api/calendar/outbox", tags=["calendar"])
    def get_outbox() -> dict:
        with session(settings.db_path) as conn:
            return {"operations": list_outbox(conn)}

    @app.post("/api/calendar/outbox/{outbox_id}/retry", tags=["calendar"])
    def post_retry(outbox_id: str, request: Request) -> dict:
        _require_human(request)
        operation = process_outbox(settings, adapter, outbox_id)
        with session(settings.db_path) as conn:
            block = get_block(conn, operation["event_key"])
        return {"operation": operation, "block": block}

    @app.get("/api/calendar/availability", tags=["calendar"])
    def get_availability(start: str | None = None, end: str | None = None) -> dict:
        start_at = parse_utc(start) if start else utc_now()
        end_at = parse_utc(end) if end else utc_now() + timedelta(days=2)
        return availability_report(settings, adapter, start_at, end_at)

    @app.get("/api/calendar/suggestion", tags=["calendar"])
    def get_suggestion(task_id: str | None = None, duration_minutes: int | None = None) -> dict:
        minutes = duration_minutes
        if minutes is None and task_id:
            with read_session(settings.db_path) as conn:
                task = get_task(conn, task_id)
                if task and task["estimate_hours"]:
                    minutes = int(round(float(task["estimate_hours"]) * 60))
        if minutes is None:
            minutes = 60
        minutes = min(12 * 60, max(15, minutes))
        return suggest_slot(settings, adapter, duration_minutes=minutes)

    @app.get("/api/audit", tags=["audit"])
    def get_audit(limit: int = 30) -> dict:
        bounded = min(max(limit, 1), 100)
        with session(settings.db_path) as conn:
            return {"entries": list_audit(conn, bounded)}

    @app.get("/api/admin/export", tags=["admin"])
    def get_export(request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            return export_snapshot(conn)

    @app.post("/api/admin/backup", tags=["admin"])
    def post_backup(request: Request) -> dict:
        _require_human(request)
        with session(settings.db_path) as conn:
            path = write_backup_file(conn, settings.data_dir)
        return {"saved": True, "filename": path.name, "path": str(path)}

    @app.post("/api/admin/restore", tags=["admin"])
    def post_restore(body: RestoreBody, request: Request) -> dict:
        _require_human(request)
        if body.confirm != "REPLACE_LOCAL_DATA":
            raise Problem(400, "confirmation_required", "Set confirm to REPLACE_LOCAL_DATA. Nothing was restored.")
        with session(settings.db_path) as conn:
            return restore_snapshot(conn, body.snapshot)

    @app.api_route("/api/manager", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], tags=["manager"])
    def manager_deferred_root() -> None:
        raise Problem(
            501,
            "manager_access_deferred",
            "Manager access is not implemented. A Work/Life switch is only a view filter and is not "
            "an authorization boundary. No work-only manager view is available.",
        )

    @app.api_route("/api/manager/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], tags=["manager"])
    def manager_deferred(rest: str) -> None:
        del rest
        raise Problem(
            501,
            "manager_access_deferred",
            "Manager access is not implemented. A Work/Life switch is only a view filter and is not "
            "an authorization boundary. No work-only manager view is available.",
        )

    return app
