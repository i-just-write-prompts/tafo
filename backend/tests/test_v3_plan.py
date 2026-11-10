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


def settings_for(tmp_path, e2e: bool = False) -> Settings:
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
        e2e=e2e,
    )


def open_week(tmp_path, e2e: bool = False):
    settings = settings_for(tmp_path, e2e=e2e)
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


def test_repeating_a_commit_with_the_same_key_changes_nothing(tmp_path):
    client = open_week(tmp_path)
    try:
        spec = block_named(client, "Spec review")
        body = {
            "confirmed": True,
            "moves": [
                {
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 9, 30),
                    "ends_at": local(2, 11),
                    "idempotency_key": "v3-plan-spec-once",
                    "title": "Spec review",
                }
            ],
            "approvals": [],
        }
        first = client.post("/api/decisions/plan/commit", json=body)
        assert first.status_code == 200, first.text
        assert first.json()["moves"][0]["saved"] is True
        moved = block_named(client, "Spec review")
        second = client.post("/api/decisions/plan/commit", json=body)
        assert second.status_code == 200, second.text
        assert second.json()["moves"][0]["idempotent_replay"] is True
        again = block_named(client, "Spec review")
        assert again["starts_at"] == moved["starts_at"] == local(2, 9, 30)
        assert again["version"] == moved["version"]
        updates = [
            row for row in client.get("/api/hermes/proposals").json()["proposals"]
            if row["idempotency_key"] == "v3-plan-spec-once"
        ]
        assert len(updates) == 1
    finally:
        client.__exit__(None, None, None)


def _failed_result():
    from tafo.calendar_adapter import AdapterResult

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


def test_r4_stale_same_key_replay_returns_409_and_keeps_newer_time(tmp_path):
    from tafo.calendar_adapter import build_adapter

    settings = settings_for(tmp_path)
    V3Week.load(settings.db_path)
    inner = build_adapter(settings)

    class Gate:
        mode = "demo"

        def __init__(self):
            self.updates: set[str] = set()

        def read_busy(self, *args, **kwargs):
            return inner.read_busy(*args, **kwargs)

        def create_block(self, *args, **kwargs):
            return inner.create_block(*args, **kwargs)

        def cancel_block(self, *args, **kwargs):
            return inner.cancel_block(*args, **kwargs)

        def update_block(self, event_key, payload, known_google_id=None):
            if event_key in self.updates:
                self.updates.discard(event_key)
                return _failed_result()
            return inner.update_block(event_key, payload, known_google_id)

    gate = Gate()
    client = TestClient(create_app(settings, adapter=gate))
    client.__enter__()
    try:
        spec = block_named(client, "Spec review")
        gate.updates.add(spec["id"])
        first = {
            "block_id": spec["id"],
            "expected_version": spec["version"],
            "starts_at": local(2, 9, 30),
            "ends_at": local(2, 11),
            "idempotency_key": "v3-plan-spec-first",
            "title": "Spec review",
        }
        failed = client.post("/api/decisions/plan/commit", json={"confirmed": True, "moves": [first], "approvals": []})
        assert failed.status_code == 200, failed.text
        assert failed.json()["moves"][0]["saved"] is False
        assert block_named(client, "Spec review")["starts_at"] == spec["starts_at"]
        newer = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [{
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 13),
                    "ends_at": local(2, 14, 30),
                    "idempotency_key": "v3-plan-spec-newer",
                    "title": "Spec review",
                }],
                "approvals": [],
            },
        )
        assert newer.status_code == 200, newer.text
        assert block_named(client, "Spec review")["starts_at"] == local(2, 13)
        replay = client.post("/api/decisions/plan/commit", json={"confirmed": True, "moves": [first], "approvals": []})
        assert replay.status_code == 409
        assert replay.json()["detail"]["code"] == "version_conflict"
        assert block_named(client, "Spec review")["starts_at"] == local(2, 13)
    finally:
        client.__exit__(None, None, None)


def test_r5_unsynced_moved_proposal_does_not_block_healthy_moves(tmp_path):
    from tafo.calendar_adapter import build_adapter

    settings = settings_for(tmp_path)
    V3Week.load(settings.db_path)
    inner = build_adapter(settings)

    class Gate:
        mode = "demo"

        def __init__(self):
            self.creates = 1

        def read_busy(self, *args, **kwargs):
            return inner.read_busy(*args, **kwargs)

        def update_block(self, *args, **kwargs):
            return inner.update_block(*args, **kwargs)

        def cancel_block(self, *args, **kwargs):
            return inner.cancel_block(*args, **kwargs)

        def create_block(self, *args, **kwargs):
            if self.creates:
                self.creates -= 1
                return _failed_result()
            return inner.create_block(*args, **kwargs)

    gate = Gate()
    client = TestClient(create_app(settings, adapter=gate))
    client.__enter__()
    try:
        budget = proposal_named(client, "Budget sheet")
        spec = block_named(client, "Spec review")
        moved_start = local(1, 15)
        moved_end = local(1, 16, 30)
        first = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [],
                "approvals": [{
                    "proposal_id": budget["id"],
                    "expected_version": budget["version"],
                    "starts_at": moved_start,
                    "ends_at": moved_end,
                }],
            },
        )
        assert first.status_code == 200, first.text
        assert first.json()["approvals"][0]["saved"] is False
        assert proposal_named(client, "Budget sheet")["status"] == "approved"
        second = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [{
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 9, 30),
                    "ends_at": local(2, 11),
                    "idempotency_key": "v3-plan-spec-healthy",
                    "title": "Spec review",
                }],
                "approvals": [{
                    "proposal_id": budget["id"],
                    "expected_version": budget["version"],
                    "starts_at": moved_start,
                    "ends_at": moved_end,
                }],
            },
        )
        assert second.status_code == 200, second.text
        assert block_named(client, "Spec review")["starts_at"] == local(2, 9, 30)
        task_id = budget["payload"]["task_id"]
        written = [
            row for row in client.get("/api/calendar/blocks").json()["blocks"]
            if row["task_id"] == task_id and row["status"] == "scheduled"
        ]
        assert any(row["starts_at"] == moved_start for row in written)
    finally:
        client.__exit__(None, None, None)


def test_r6_mismatched_or_denied_proposal_retries_are_409(tmp_path):
    client = open_week(tmp_path)
    try:
        budget = proposal_named(client, "Budget sheet")
        spec = block_named(client, "Spec review")
        closet = proposal_named(client, "Fix closet door")
        original = spec["starts_at"]
        moved = local(1, 15)
        moved_end = local(1, 16, 30)
        approved = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [],
                "approvals": [{
                    "proposal_id": budget["id"],
                    "expected_version": budget["version"],
                    "starts_at": moved,
                    "ends_at": moved_end,
                }],
            },
        )
        assert approved.status_code == 200, approved.text
        mismatch = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [{
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 9, 30),
                    "ends_at": local(2, 11),
                    "idempotency_key": "v3-r6-mismatch-spec",
                    "title": "Spec review",
                }],
                "approvals": [{
                    "proposal_id": budget["id"],
                    "expected_version": budget["version"],
                    "starts_at": local(1, 16),
                    "ends_at": local(1, 17, 30),
                }],
            },
        )
        assert mismatch.status_code == 409, mismatch.text
        assert mismatch.json()["detail"]["code"] == "not_pending"
        assert block_named(client, "Spec review")["starts_at"] == original
        task_id = budget["payload"]["task_id"]
        written = [
            row for row in client.get("/api/calendar/blocks").json()["blocks"]
            if row["task_id"] == task_id and row["status"] == "scheduled"
        ]
        assert any(row["starts_at"] == moved for row in written)
        assert not any(row["starts_at"] == local(1, 16) for row in written)
        rejected = client.post(
            f"/api/decisions/{closet['id']}/reject",
            json={"expected_version": closet["version"], "confirmed": True, "note": "No"},
        )
        assert rejected.status_code == 200, rejected.text
        denied = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [],
                "approvals": [{
                    "proposal_id": closet["id"],
                    "expected_version": closet["version"],
                    "starts_at": local(1, 18),
                    "ends_at": local(1, 19),
                }],
            },
        )
        assert denied.status_code == 409, denied.text
        assert denied.json()["detail"]["code"] == "not_pending"
        assert proposal_named(client, "Fix closet door")["status"] == "rejected"
    finally:
        client.__exit__(None, None, None)


def test_demo_fail_writes_endpoint_fails_one_update_and_live_omits_it(tmp_path):
    quiet = open_week(tmp_path)
    try:
        missing = quiet.post("/api/e2e/fail-writes", json={"event_keys": ["blk_v3_spec"]})
        assert missing.status_code == 404
    finally:
        quiet.__exit__(None, None, None)
    armed = tmp_path / "armed"
    armed.mkdir()
    client = open_week(armed, e2e=True)
    try:
        spec = block_named(client, "Spec review")
        armed = client.post("/api/e2e/fail-writes", json={"event_keys": [spec["id"]], "fail_creates": 1})
        assert armed.status_code == 200, armed.text
        assert armed.json()["event_keys"] == [spec["id"]]
        assert armed.json()["fail_creates"] == 1
        failed = client.post(
            "/api/decisions/plan/commit",
            json={
                "confirmed": True,
                "moves": [{
                    "block_id": spec["id"],
                    "expected_version": spec["version"],
                    "starts_at": local(2, 9, 30),
                    "ends_at": local(2, 11),
                    "idempotency_key": "v3-demo-fail-writes",
                    "title": "Spec review",
                }],
                "approvals": [],
            },
        )
        assert failed.status_code == 200, failed.text
        assert failed.json()["moves"][0]["saved"] is False
        assert block_named(client, "Spec review")["starts_at"] == spec["starts_at"]
    finally:
        client.__exit__(None, None, None)

    live = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=tmp_path / "live.sqlite",
        display_timezone="America/Indianapolis",
        calendar_mode="live",
        google_credentials_file="",
        google_calendar_id="cal-demo",
        work_invite_email="worker@example.com",
        allow_lan=False,
        seed_demo=False,
    )
    with TestClient(create_app(live)) as live_client:
        missing = live_client.post("/api/e2e/fail-writes", json={"event_keys": ["blk_v3_spec"]})
        assert missing.status_code == 404


def test_commit_refuses_an_empty_plan(tmp_path):
    client = open_week(tmp_path)
    try:
        response = client.post("/api/decisions/plan/commit", json={"confirmed": True, "moves": [], "approvals": []})
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "empty_plan"
    finally:
        client.__exit__(None, None, None)
