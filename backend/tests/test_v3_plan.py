"""Plan mode commits every staged move and included proposal together."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from tafo.app import create_app
from tafo.config import Settings
from tafo.v3_fixture import V3Week

ZONE = ZoneInfo("America/Indianapolis")


def local(day: int, hour: int, minute: int = 0) -> str:
    moment = datetime(2026, 11, 9, hour, minute, tzinfo=ZONE) + timedelta(days=day)
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def settings_for(tmp_path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=tmp_path / "tafo.sqlite",
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
    )


def open_week(tmp_path):
    settings = settings_for(tmp_path)
    V3Week.load(settings.db_path)
    app = create_app(settings)
    client = TestClient(app)
    client.__enter__()
    return client


def block_named(client: TestClient, title: str, start: str | None = None) -> dict:
    rows = client.get("/api/calendar/blocks").json()["blocks"]
    matches = [row for row in rows if row["title"] == title and row["status"] == "scheduled"]
    if start is not None:
        matches = [row for row in matches if row["starts_at"] == start]
    assert len(matches) == 1, matches
    return matches[0]


def proposal_named(client: TestClient, title: str) -> dict:
    rows = client.get("/api/hermes/proposals").json()["proposals"]
    matches = []
    for row in rows:
        payload = row["edited_payload"] or row["payload"]
        task_id = payload.get("task_id")
        tasks = client.get("/api/tasks").json()["tasks"]
        task = next((item for item in tasks if item["id"] == task_id), None)
        if task and task["title"] == title:
            matches.append(row)
    assert len(matches) == 1
    return matches[0]


def test_v3_week_matches_the_phone_story(tmp_path):
    client = open_week(tmp_path)
    try:
        vendor = block_named(client, "Call vendor")
        assert vendor["starts_at"] == local(1, 10)
        assert vendor["ends_at"] == local(1, 10, 30)
        standup = block_named(client, "Standup", local(1, 9))
        task = next(item for item in client.get("/api/tasks").json()["tasks"] if item["id"] == standup["task_id"])
        assert task["status"] == "done"
        budget = proposal_named(client, "Budget sheet")
        closet = proposal_named(client, "Fix closet door")
        assert budget["status"] == "pending"
        assert budget["explanation"] == "due Fri; longest free work stretch today."
        assert closet["status"] == "pending"
        scheduled = {
            row["task_id"]
            for row in client.get("/api/calendar/blocks").json()["blocks"]
            if row["status"] == "scheduled" and row["task_id"]
        }
        pending_tasks = set()
        for row in client.get("/api/hermes/proposals?status=pending").json()["proposals"]:
            payload = row["payload"]
            if payload.get("task_id"):
                pending_tasks.add(payload["task_id"])
        loose = [
            item["title"]
            for item in client.get("/api/tasks").json()["tasks"]
            if item["status"] != "done" and item["id"] not in scheduled and item["id"] not in pending_tasks
        ]
        assert sorted(loose) == ["Buy stamps", "Oil change", "Read chapter 4", "Renew passport"]
    finally:
        client.__exit__(None, None, None)


def test_commit_applies_moves_and_the_included_proposal(tmp_path):
    client = open_week(tmp_path)
    try:
        spec = block_named(client, "Spec review")
        lunch = block_named(client, "Lunch w/ Sam")
        gym = block_named(client, "Gym")
        rosa = block_named(client, "Call Grandma Rosa")
        closet = proposal_named(client, "Fix closet door")
        budget = proposal_named(client, "Budget sheet")
        response = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [
                    {
                        "block_id": spec["id"],
                        "expected_version": spec["version"],
                        "starts_at": local(2, 9, 30),
                        "ends_at": local(2, 11),
                        "idempotency_key": "v3-plan-spec",
                        "title": "Spec review",
                    },
                    {
                        "block_id": lunch["id"],
                        "expected_version": lunch["version"],
                        "starts_at": local(3, 12),
                        "ends_at": local(3, 13),
                        "idempotency_key": "v3-plan-lunch",
                        "title": "Lunch w/ Sam",
                    },
                    {
                        "block_id": gym["id"],
                        "expected_version": gym["version"],
                        "starts_at": local(0, 17),
                        "ends_at": local(0, 18),
                        "idempotency_key": "v3-plan-gym",
                        "title": "Gym",
                    },
                    {
                        "block_id": rosa["id"],
                        "expected_version": rosa["version"],
                        "starts_at": local(3, 16, 30),
                        "ends_at": local(3, 17, 30),
                        "idempotency_key": "v3-plan-rosa",
                        "title": "Call Grandma Rosa",
                    },
                ],
                "approvals": [{"proposal_id": closet["id"], "expected_version": closet["version"]}],
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert len(body["moves"]) == 4
        assert len(body["approvals"]) == 1
        assert block_named(client, "Spec review")["starts_at"] == local(2, 9, 30)
        assert block_named(client, "Lunch w/ Sam")["starts_at"] == local(3, 12)
        assert block_named(client, "Gym")["starts_at"] == local(0, 17)
        assert block_named(client, "Call Grandma Rosa")["starts_at"] == local(3, 16, 30)
        assert proposal_named(client, "Fix closet door")["status"] == "approved"
        assert proposal_named(client, "Budget sheet")["status"] == "pending"
        assert budget["id"] == proposal_named(client, "Budget sheet")["id"]
    finally:
        client.__exit__(None, None, None)


def test_commit_rolls_back_when_one_approval_is_stale(tmp_path):
    client = open_week(tmp_path)
    try:
        spec = block_named(client, "Spec review")
        closet = proposal_named(client, "Fix closet door")
        original = spec["starts_at"]
        response = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [
                    {
                        "block_id": spec["id"],
                        "expected_version": spec["version"],
                        "starts_at": local(2, 9, 30),
                        "ends_at": local(2, 11),
                        "idempotency_key": "v3-plan-spec-fail",
                        "title": "Spec review",
                    }
                ],
                "approvals": [{"proposal_id": closet["id"], "expected_version": closet["version"] + 9}],
            },
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "version_conflict"
        assert block_named(client, "Spec review")["starts_at"] == original
        assert block_named(client, "Spec review")["version"] == spec["version"]
        assert proposal_named(client, "Fix closet door")["status"] == "pending"
        pending = client.get("/api/hermes/proposals?status=pending").json()["proposals"]
        assert all(row["kind"] != "calendar_update" for row in pending)
    finally:
        client.__exit__(None, None, None)


def test_failed_calendar_write_keeps_the_old_time_and_reports_it(tmp_path):
    from tafo.calendar_adapter import AdapterResult, build_adapter

    settings = settings_for(tmp_path)
    V3Week.load(settings.db_path)
    inner = build_adapter(settings)

    class FailUpdate:
        mode = "demo"

        def __init__(self):
            self.keys: set[str] = set()

        def read_busy(self, *args, **kwargs):
            return inner.read_busy(*args, **kwargs)

        def create_block(self, *args, **kwargs):
            return inner.create_block(*args, **kwargs)

        def cancel_block(self, *args, **kwargs):
            return inner.cancel_block(*args, **kwargs)

        def update_block(self, event_key, payload, known_google_id=None):
            if event_key in self.keys:
                return AdapterResult(
                    ok=False,
                    status="failed",
                    sync_state="not_synced",
                    google_event_id=None,
                    honest_label="Not synced. The calendar write failed.",
                    steps=[],
                    error="forced_failure",
                    mode="demo",
                )
            return inner.update_block(event_key, payload, known_google_id)

    gate = FailUpdate()
    client = TestClient(create_app(settings, adapter=gate))
    client.__enter__()
    try:
        spec = block_named(client, "Spec review")
        closet = proposal_named(client, "Fix closet door")
        gate.keys.add(spec["id"])
        response = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [
                    {
                        "block_id": spec["id"],
                        "expected_version": spec["version"],
                        "starts_at": local(2, 9, 30),
                        "ends_at": local(2, 11),
                        "idempotency_key": "v3-plan-spec-fail-write",
                        "title": "Spec review",
                    }
                ],
                "approvals": [{"proposal_id": closet["id"], "expected_version": closet["version"]}],
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["moves"][0]["saved"] is False
        assert body["moves"][0]["outcome"] == "not_synced"
        assert body["moves"][0]["item_title"] == "Spec review"
        assert body["approvals"][0]["saved"] is True
        fresh = block_named(client, "Spec review")
        assert fresh["starts_at"] == spec["starts_at"]
        assert fresh["version"] == spec["version"]
        assert proposal_named(client, "Fix closet door")["status"] == "approved"
    finally:
        client.__exit__(None, None, None)


def test_plan_commit_requires_the_ui_session(tmp_path):
    client = open_week(tmp_path)
    try:
        spec = block_named(client, "Spec review")
        closet = proposal_named(client, "Fix closet door")
        original = spec["starts_at"]
        client.inject_ui_session = False
        body = {
            "confirmed": True,
            "moves": [
                {
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 9, 30),
                    "ends_at": local(2, 11),
                    "idempotency_key": "v3-plan-no-session",
                    "title": "Spec review",
                }
            ],
            "approvals": [{"proposal_id": closet["id"], "expected_version": closet["version"]}],
        }
        missing = client.post("/api/decisions/plan/commit", json=body)
        assert missing.status_code == 403
        assert missing.json()["detail"]["code"] == "ui_session_required"
        agent = client.post("/api/decisions/plan/commit", json=body, headers={"X-TAFO-Actor": "agent"})
        assert agent.status_code == 403
        assert block_named(client, "Spec review")["starts_at"] == original
        assert proposal_named(client, "Fix closet door")["status"] == "pending"
    finally:
        client.__exit__(None, None, None)


def test_commit_refuses_an_empty_plan(tmp_path):
    client = open_week(tmp_path)
    try:
        response = client.post("/api/decisions/plan/commit", json={"confirmed": True, "moves": [], "approvals": []})
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "empty_plan"
    finally:
        client.__exit__(None, None, None)
