"""Fictional week used by the v3 calendar (Mon Nov 9–Sun Nov 15, 2026).

Times are America/Indianapolis local clock times. Nothing here is a real
calendar, and this loader refuses the default data/tafo.sqlite file.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from tafo.calendar_adapter import DEMO_HONEST_LABEL, build_adapter
from tafo.config import Settings
from tafo.db import connect
from tafo.decisions import create_proposal
from tafo.migrate import apply_migrations
from tafo.tasks import create_task
from tafo.timeutil import fmt_utc, utc_now_iso

ZONE = ZoneInfo("America/Indianapolis")
MONDAY = datetime(2026, 11, 9, tzinfo=ZONE)


class FixturePathError(RuntimeError):
    """The requested database is the default runtime file."""


def _local(day: int, hour: float) -> str:
    hours = int(hour)
    minutes = int(round((hour - hours) * 60))
    if minutes == 60:
        hours += 1
        minutes = 0
    moment = (MONDAY + timedelta(days=day)).replace(hour=hours, minute=minutes, second=0, microsecond=0)
    return fmt_utc(moment.astimezone(ZONE))


# id, title, domain, weekday (Mon=0), start hour, end hour, state
EVENTS = (
    ("m1", "Standup", "work", 0, 9, 9.5, "approved"),
    ("m2", "Draft Q4 notes", "work", 0, 10.5, 12, "approved"),
    ("gym", "Gym", "personal", 0, 13, 14, "approved"),
    ("m4", "Water herbs", "home", 0, 18, 18.5, "approved"),
    ("t1", "Standup", "work", 1, 9, 9.5, "done"),
    ("spec", "Spec review", "work", 1, 9.5, 11, "approved"),
    ("t3", "Call vendor", "work", 1, 10, 10.5, "approved"),
    ("lunch", "Lunch w/ Sam", "personal", 1, 12, 13, "approved"),
    ("budget", "Budget sheet", "work", 1, 14, 15.5, "proposed"),
    ("closet", "Fix closet door", "home", 1, 17, 18, "proposed"),
    ("w1", "Standup", "work", 2, 9, 9.5, "approved"),
    ("w2", "Dentist", "personal", 2, 11, 12, "approved"),
    ("w3", "Deep work", "work", 2, 13, 15, "approved"),
    ("w4", "Plan hike route", "personal", 2, 16, 17, "approved"),
    ("h1", "Standup", "work", 3, 9, 9.5, "approved"),
    ("h2", "Design crit", "work", 3, 10, 11.5, "approved"),
    ("h5", "Coffee w/ Jo", "personal", 3, 10.5, 11, "approved"),
    ("h3", "Dry cleaning", "personal", 3, 14, 14.5, "approved"),
    ("h4", "1:1 with Ana", "work", 3, 15, 16, "approved"),
    ("f1", "Standup", "work", 4, 9, 9.5, "approved"),
    ("f2", "Write report", "work", 4, 10, 12, "approved"),
    ("rosa", "Call Grandma Rosa", "personal", 4, 18, 19, "approved"),
    ("s1", "Hike", "personal", 5, 9, 11.5, "approved"),
    ("s2", "Groceries", "home", 5, 15, 16, "approved"),
    ("u1", "Brunch", "personal", 6, 10, 11, "approved"),
    ("u2", "Meal prep", "home", 6, 16, 17, "approved"),
)

UNSCHEDULED = (
    ("stamps", "Buy stamps", "personal"),
    ("passport", "Renew passport", "personal"),
    ("oil", "Oil change", "home"),
    ("chapter", "Read chapter 4", "personal"),
)

PROPOSAL_WHY = {
    "budget": "due Fri; longest free work stretch today.",
    "closet": "Home task for Tuesday evening.",
}


class V3Week:
    @staticmethod
    def repo_root() -> Path:
        return Path(__file__).resolve().parents[2]

    @staticmethod
    def forbidden(db_path: Path) -> bool:
        resolved = db_path.expanduser().resolve()
        defaults = {
            (V3Week.repo_root() / "data" / "tafo.sqlite").resolve(),
            (Path.cwd() / "data" / "tafo.sqlite").resolve(),
        }
        return resolved in defaults

    @staticmethod
    def settings_for(db_path: Path) -> Settings:
        if V3Week.forbidden(db_path):
            raise FixturePathError(
                "Refusing to write the default database data/tafo.sqlite. "
                "Pass an explicit throwaway path."
            )
        resolved = db_path.expanduser().resolve()
        return Settings(
            host="127.0.0.1",
            port=8787,
            data_dir=resolved.parent,
            db_path=resolved,
            display_timezone="America/Indianapolis",
            calendar_mode="demo",
            google_credentials_file="",
            google_calendar_id="",
            work_invite_email="",
            allow_lan=False,
            seed_demo=False,
        )

    @staticmethod
    def load(db_path: Path) -> None:
        settings = V3Week.settings_for(db_path)
        adapter = build_adapter(settings)
        conn = connect(settings.db_path)
        proposals: list[dict] = []
        try:
            apply_migrations(conn)
            conn.execute("BEGIN IMMEDIATE")
            try:
                order = 10
                for event_id, title, domain, day, start, end, state in EVENTS:
                    task_id = f"task_v3_{event_id}"
                    create_task(
                        conn,
                        {
                            "id": task_id,
                            "title": title,
                            "domain": domain,
                            "status": "done" if state == "done" else "todo",
                            "estimate_hours": round(end - start, 2),
                            "due_date": "2026-11-13" if event_id == "budget" else None,
                            "on_today": day == 1,
                            "sort_order": order,
                        },
                        actor="human",
                    )
                    order += 10
                    if state == "proposed":
                        proposals.append(
                            {
                                "source": "sample-agent",
                                "source_kind": "agent",
                                "kind": "calendar_block",
                                "explanation": PROPOSAL_WHY[event_id],
                                "idempotency_key": f"v3-{event_id}",
                                "payload": {
                                    "task_id": task_id,
                                    "domain": domain,
                                    "starts_at": _local(day, start),
                                    "ends_at": _local(day, end),
                                },
                            }
                        )
                        continue
                    stamp = utc_now_iso()
                    conn.execute(
                        """
                        INSERT INTO calendar_blocks (
                          id, task_id, origin_proposal_id, title, description, starts_at, ends_at, domain,
                          invite_work_email, fixed, status, sync_state, written_mode, honest_label,
                          google_event_id, version, created_at, updated_at
                        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 'scheduled', 'simulated', 'demo', ?, NULL, 1, ?, ?)
                        """,
                        (
                            f"blk_v3_{event_id}",
                            task_id,
                            title,
                            "Time block created by TAFO.",
                            _local(day, start),
                            _local(day, end),
                            domain,
                            DEMO_HONEST_LABEL,
                            stamp,
                            stamp,
                        ),
                    )
                for event_id, title, domain in UNSCHEDULED:
                    create_task(
                        conn,
                        {
                            "id": f"task_v3_{event_id}",
                            "title": title,
                            "domain": domain,
                            "status": "todo",
                            "estimate_hours": 0.5,
                            "on_today": False,
                            "sort_order": order,
                        },
                        actor="human",
                    )
                    order += 10
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.close()
        for body in proposals:
            create_proposal(settings, adapter, body, "agent")
