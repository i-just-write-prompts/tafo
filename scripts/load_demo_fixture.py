"""Load the Slice 1 review journey into an explicit database path.

This does not call the generic sample seed. It refuses the default
data/tafo.sqlite, whether that path is relative or absolute.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tafo.calendar_adapter import build_adapter
from tafo.config import Settings
from tafo.db import connect, session
from tafo.decisions import create_proposal, stage_approval
from tafo.migrate import apply_migrations
from tafo.outbox import process_outbox
from tafo.tasks import create_task, get_task


class FixturePathError(RuntimeError):
    """The requested database is the default runtime file."""


class JourneyFixture:
    TASKS = (
        {
            "id": "task_journey_herbs",
            "title": "Water the balcony herbs",
            "domain": "home",
            "estimate_hours": 0.25,
            "on_today": False,
        },
        {
            "id": "task_journey_cleaning",
            "title": "Pick up dry cleaning",
            "domain": "personal",
            "estimate_hours": 0.5,
            "on_today": False,
        },
        {
            "id": "task_journey_grandma",
            "title": "Call Grandma Rosa",
            "domain": "personal",
            "estimate_hours": 0.5,
            "on_today": False,
        },
        {
            "id": "task_journey_door",
            "title": "Fix the squeaky closet door",
            "domain": "home",
            "estimate_hours": 1,
            "on_today": False,
        },
        {
            "id": "task_journey_hike",
            "title": "Plan Saturday hike route",
            "domain": "personal",
            "estimate_hours": 1.5,
            "on_today": False,
        },
        {
            "id": "task_journey_ladder",
            "title": "Hold the ladder",
            "domain": "home",
            "estimate_hours": 1,
            "on_today": False,
        },
    )
    FIXED_PROPOSAL = {
        "source": "plan",
        "source_kind": "human",
        "kind": "calendar_block",
        "explanation": "Fixed hold.",
        "idempotency_key": "plan.fixed.ladder",
        "payload": {
            "task_id": "task_journey_ladder",
            "domain": "home",
            "starts_at": "2026-11-04T21:00:00Z",
            "ends_at": "2026-11-04T22:00:00Z",
            "fixed": True,
            "allow_custom_title": True,
            "title": "Hold the ladder",
        },
    }
    AGENT_PROPOSALS = (
        {
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "agent-herbs-journey",
            "idempotency_key": "agent-herbs-journey",
            "payload": {
                "task_id": "task_journey_herbs",
                "domain": "home",
                "starts_at": "2026-11-04T16:00:00Z",
                "ends_at": "2026-11-04T16:15:00Z",
            },
        },
        {
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "agent-door-journey",
            "idempotency_key": "agent-door-journey",
            "payload": {
                "task_id": "task_journey_door",
                "domain": "home",
                "starts_at": "2026-11-04T18:00:00Z",
                "ends_at": "2026-11-04T19:00:00Z",
            },
        },
        {
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "agent-clean-journey",
            "idempotency_key": "agent-clean-journey",
            "payload": {
                "task_id": "task_journey_cleaning",
                "domain": "personal",
                "starts_at": "2026-11-05T15:00:00Z",
                "ends_at": "2026-11-05T15:30:00Z",
            },
        },
    )

    @staticmethod
    def repo_root() -> Path:
        return Path(__file__).resolve().parents[1]

    @staticmethod
    def forbidden(db_path: Path) -> bool:
        resolved = db_path.expanduser().resolve()
        defaults = {
            (JourneyFixture.repo_root() / "data" / "tafo.sqlite").resolve(),
            (Path.cwd() / "data" / "tafo.sqlite").resolve(),
        }
        return resolved in defaults

    @staticmethod
    def settings_for(db_path: Path) -> Settings:
        if JourneyFixture.forbidden(db_path):
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
        settings = JourneyFixture.settings_for(db_path)
        adapter = build_adapter(settings)
        conn = connect(settings.db_path)
        try:
            apply_migrations(conn)
            conn.execute("BEGIN IMMEDIATE")
            try:
                for fields in JourneyFixture.TASKS:
                    if get_task(conn, fields["id"]) is None:
                        create_task(conn, fields, actor="human")
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.close()
        proposal, _replay = create_proposal(settings, adapter, JourneyFixture.FIXED_PROPOSAL, "human")
        if proposal["status"] == "pending":
            with session(settings.db_path) as conn:
                staged = stage_approval(
                    conn,
                    settings,
                    proposal["id"],
                    expected_version=proposal["version"],
                    note="",
                    acknowledge_fixed_move=False,
                    acknowledge_task_drift=False,
                    actor="human",
                )
            outbox_id = staged.get("outbox_id")
            if outbox_id and staged.get("outbox_status") not in {"simulated", "synced"}:
                process_outbox(settings, adapter, outbox_id)
        for body in JourneyFixture.AGENT_PROPOSALS:
            create_proposal(settings, adapter, body, "agent")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load the Slice 1 review fixture into an explicit SQLite file.")
    parser.add_argument("db_path", help="Database file to create or update. Refuses data/tafo.sqlite.")
    args = parser.parse_args(argv)
    try:
        JourneyFixture.load(Path(args.db_path))
    except FixturePathError as exc:
        print(exc, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
