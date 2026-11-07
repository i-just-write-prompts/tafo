"""Regression tests for the review at 5b0ec86.

Each test encodes the broken behavior from that review. Windows was not
booted: the pid check is simulated by making os.kill raise OSError.
"""

import threading
import time
import urllib.parse
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from tafo.calendar_adapter import GoogleCalendarAdapter, TransportError, deterministic_event_id
from tafo.config import host_is_loopback
from tafo.db import connect, session
from tafo.decisions import stage_approval
from tafo.outbox import PROCESSING, Outbox, process_outbox
from tafo.problems import Problem
from tafo.tasks import create_task, move_task
from tafo.timeutil import fmt_utc, utc_now

from tests.conftest import add_task
from tests.test_calendar_outbox import SimulatedCrash, _live_settings, _proposal


class SplitBrainTransport:
    """Lookup by extended property can miss an event that GET-by-id still finds."""

    def __init__(self) -> None:
        self.events: dict[str, dict] = {}
        self.posts = 0
        self.deletes = 0
        self.lookup_empty = False
        self.patch_status: int | None = None
        self.fail_posts = 0
        self.retry_after: float | None = None

    def request(self, method, url, *, params=None, json_body=None, headers=None):
        assert headers["Authorization"] == "Bearer test-token"
        if method == "GET" and params and "privateExtendedProperty" in params:
            if self.lookup_empty:
                return {"items": []}
            key = params["privateExtendedProperty"].split("=", 1)[1]
            items = [
                event
                for event in self.events.values()
                if event.get("extendedProperties", {}).get("private", {}).get("tafoEventKey") == key
            ]
            return {"items": items}
        if method == "GET" and "/events/" in url:
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            event = self.events.get(event_id)
            if event is None:
                raise TransportError(404, "missing")
            return event
        if method == "POST" and url.endswith("/events"):
            self.posts += 1
            if self.fail_posts > 0:
                self.fail_posts -= 1
                raise TransportError(503, "later", retry_after=self.retry_after)
            supplied = (json_body or {}).get("id")
            event_id = supplied or f"g{self.posts}"
            if event_id in self.events:
                raise TransportError(409, "duplicate")
            event = {"id": event_id, **(json_body or {})}
            event["id"] = event_id
            self.events[event_id] = event
            return event
        if method == "POST" and url.endswith("/freeBusy"):
            return {"calendars": {"cal-demo": {"busy": []}}}
        if method == "PATCH":
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            if self.patch_status in {404, 410}:
                status = self.patch_status
                self.patch_status = None
                raise TransportError(status, "gone")
            if event_id not in self.events:
                raise TransportError(404, "missing")
            self.events[event_id].update(json_body or {})
            self.events[event_id]["id"] = event_id
            return self.events[event_id]
        if method == "DELETE":
            self.deletes += 1
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            self.events.pop(event_id, None)
            return {}
        raise AssertionError(f"unexpected {method} {url}")


class CrashAfterPost:
    mode = "live"

    def __init__(self, transport: SplitBrainTransport) -> None:
        self.calls = 0
        self.inner = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")

    def read_busy(self, start, end):
        del start, end
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        self.calls += 1
        result = self.inner.create_block(event_key, payload, known_google_id)
        if self.calls == 1:
            raise SimulatedCrash("google accepted the create")
        return result

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.inner.cancel_block(event_key, payload, known_google_id)


def test_crash_after_create_with_empty_lookup_does_not_post_again(tmp_path):
    transport = SplitBrainTransport()
    adapter = CrashAfterPost(transport)
    settings = _live_settings(tmp_path)
    app = __import__("tafo.app", fromlist=["create_app"]).create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        task = add_task(client, title="Crash sample")
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Create once even if lookup later misses it.",
                "payload": {
                    "task_id": task["id"],
                    "domain": "work",
                    "event_key": "evt_crash_empty",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        ).json()
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
        with pytest.raises(SimulatedCrash):
            process_outbox(settings, adapter, staged["outbox_id"])
        assert transport.posts == 1
        assert len(transport.events) == 1
        transport.lookup_empty = True
        recovered = process_outbox(settings, adapter, staged["outbox_id"])
        assert recovered["status"] == "synced"
        assert transport.posts == 1
        assert len(transport.events) == 1
        assert recovered["google_event_id"] in transport.events
        assert recovered["google_event_id"] == deterministic_event_id("evt_crash_empty")


class GateLookup:
    """Holds the first lookup so a second create can observe an empty calendar."""

    def __init__(self) -> None:
        self.events: dict[str, dict] = {}
        self.posts = 0
        self.lookup_sizes: list[int] = []
        self.first_lookup = threading.Event()
        self.release = threading.Event()

    def request(self, method, url, *, params=None, json_body=None, headers=None):
        assert headers["Authorization"] == "Bearer test-token"
        if method == "GET" and params and "privateExtendedProperty" in params:
            key = params["privateExtendedProperty"].split("=", 1)[1]
            items = [
                event
                for event in self.events.values()
                if event.get("extendedProperties", {}).get("private", {}).get("tafoEventKey") == key
            ]
            self.lookup_sizes.append(len(items))
            if len(self.lookup_sizes) == 1:
                self.first_lookup.set()
                assert self.release.wait(5)
            return {"items": items}
        if method == "GET" and "/events/" in url:
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            event = self.events.get(event_id)
            if event is None:
                raise TransportError(404, "missing")
            return event
        if method == "POST" and url.endswith("/events"):
            self.posts += 1
            event_id = (json_body or {}).get("id") or f"g{self.posts}"
            if event_id in self.events:
                raise TransportError(409, "duplicate")
            event = {"id": event_id, **(json_body or {})}
            event["id"] = event_id
            self.events[event_id] = event
            return event
        if method == "PATCH":
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            self.events[event_id].update(json_body or {})
            self.events[event_id]["id"] = event_id
            return self.events[event_id]
        if method == "POST" and url.endswith("/freeBusy"):
            return {"calendars": {"cal-demo": {"busy": []}}}
        raise AssertionError(f"unexpected {method} {url}")


def test_overlapping_creates_for_one_event_key_insert_once(tmp_path):
    transport = GateLookup()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    settings = _live_settings(tmp_path)
    app = __import__("tafo.app", fromlist=["create_app"]).create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        first = _proposal(client, "evt_overlap_key")
        second = _proposal(client, "evt_overlap_key")
        with session(settings.db_path) as conn:
            staged_a = stage_approval(
                conn,
                settings,
                first["id"],
                expected_version=first["version"],
                note="",
                acknowledge_fixed_move=False,
                acknowledge_task_drift=False,
                actor="human",
            )
            staged_b = stage_approval(
                conn,
                settings,
                second["id"],
                expected_version=second["version"],
                note="",
                acknowledge_fixed_move=False,
                acknowledge_task_drift=False,
                actor="human",
            )
        holder: dict[str, dict] = {}

        def run(key: str, outbox_id: str) -> None:
            holder[key] = process_outbox(settings, adapter, outbox_id)

        left = threading.Thread(target=run, args=("a", staged_a["outbox_id"]))
        right = threading.Thread(target=run, args=("b", staged_b["outbox_id"]))
        left.start()
        assert transport.first_lookup.wait(3)
        right.start()
        time.sleep(0.3)
        transport.release.set()
        left.join(5)
        right.join(5)
        assert transport.posts == 1
        assert len(transport.events) == 1
        assert holder["a"]["google_event_id"] == holder["b"]["google_event_id"]
        assert holder["a"]["status"] == "synced"
        assert holder["b"]["status"] == "synced"


def test_stale_claim_is_reclaimed_without_os_kill(tmp_path, monkeypatch):
    """Simulated Windows: os.kill(pid, 0) raises OSError and must not be called.

    This process is Linux. A live foreign pid (1) with an expired lease is
    reclaimed from the timestamp, not from a process signal.
    """

    def explode(*_args, **_kwargs):
        raise OSError("os.kill(pid, 0) is unsafe on Windows")

    monkeypatch.setattr("tafo.outbox.os.kill", explode)
    transport = SplitBrainTransport()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    settings = _live_settings(tmp_path)
    app = __import__("tafo.app", fromlist=["create_app"]).create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        proposal = _proposal(client, "evt_stale_lease")
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
        stale = fmt_utc(utc_now() - timedelta(hours=2))
        conn = connect(settings.db_path)
        conn.execute(
            "UPDATE outbox_operations SET last_error = ?, updated_at = ?, attempt_count = 1 WHERE id = ?",
            (f"{PROCESSING}:1:deadbeef", stale, staged["outbox_id"]),
        )
        conn.close()
        box = Outbox()
        assert box.owner_busy(
            {"id": staged["outbox_id"], "last_error": f"{PROCESSING}:1:deadbeef", "updated_at": stale}
        ) is False
        fresh = utc_now_iso_now()
        assert box.owner_busy(
            {"id": "obx_other", "last_error": f"{PROCESSING}:1:alive", "updated_at": fresh}
        ) is True
        recovered = process_outbox(settings, adapter, staged["outbox_id"])
        assert recovered["status"] == "synced"
        assert transport.posts == 1


def utc_now_iso_now() -> str:
    return fmt_utc(utc_now())


class SlowRead:
    mode = "live"

    def read_busy(self, start, end):
        del start, end
        time.sleep(6)
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        del event_key, payload, known_google_id
        raise AssertionError("slow read test must not create")

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


def test_google_read_does_not_hold_the_write_lock(tmp_path):
    from tafo.app import create_app

    settings = _live_settings(tmp_path)
    app = create_app(settings, adapter=SlowRead())
    holder: dict[str, object] = {}

    def write_task(writer: TestClient) -> None:
        time.sleep(0.3)
        started = time.monotonic()
        response = writer.post(
            "/api/tasks",
            json={"title": "While calendar reads", "domain": "home", "on_today": True},
        )
        holder["status"] = response.status_code
        holder["elapsed"] = time.monotonic() - started

    with TestClient(app) as reader, TestClient(app) as writer:
        thread = threading.Thread(target=write_task, args=(writer,))
        thread.start()
        started = time.monotonic()
        availability = reader.get("/api/calendar/availability")
        thread.join(12)
        assert availability.status_code == 200, availability.text
        assert time.monotonic() - started >= 6
        assert holder["status"] == 201
        assert holder["elapsed"] < 4

        proposal_holder: dict[str, object] = {}

        def write_during_proposal(client: TestClient) -> None:
            time.sleep(0.3)
            started_write = time.monotonic()
            response = client.post(
                "/api/tasks",
                json={"title": "While proposal reads", "domain": "home", "on_today": True},
            )
            proposal_holder["status"] = response.status_code
            proposal_holder["elapsed"] = time.monotonic() - started_write

        other = threading.Thread(target=write_during_proposal, args=(writer,))
        other.start()
        created = reader.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Availability must not reserve the database.",
                "payload": {
                    "domain": "work",
                    "event_key": "evt_lock_read",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        )
        other.join(12)
        assert created.status_code == 201, created.text
        assert proposal_holder["status"] == 201
        assert proposal_holder["elapsed"] < 4


class DropTaskOnCreate:
    mode = "live"

    def __init__(self, inner, settings, task_id: str) -> None:
        self.inner = inner
        self.settings = settings
        self.task_id = task_id

    def read_busy(self, start, end):
        del start, end
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        result = self.inner.create_block(event_key, payload, known_google_id)
        conn = connect(self.settings.db_path)
        try:
            conn.execute("DELETE FROM tasks WHERE id = ?", (self.task_id,))
        finally:
            conn.close()
        return result

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.inner.cancel_block(event_key, payload, known_google_id)


def test_task_deleted_before_block_insert_keeps_google_id(tmp_path):
    transport = SplitBrainTransport()
    settings = _live_settings(tmp_path)
    holder: dict[str, str] = {}

    class Bound(DropTaskOnCreate):
        def __init__(self) -> None:
            super().__init__(
                GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token"),
                settings,
                "",
            )

    adapter = Bound()
    from tafo.app import create_app

    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        task = add_task(client, title="Vanishing sample")
        holder["id"] = task["id"]
        adapter.task_id = task["id"]
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Task may disappear before the block row is stored.",
                "payload": {
                    "task_id": task["id"],
                    "domain": "work",
                    "event_key": "evt_fk_race",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        ).json()
        approved = client.post(
            f"/api/decisions/{proposal['id']}/approve",
            json={"expected_version": proposal["version"], "confirmed": True},
        )
        assert approved.status_code == 200, approved.text
        body = approved.json()
        assert body["outbox"]["google_event_id"]
        assert body["outbox"]["status"] == "synced"
        assert body["block"]["task_id"] is None
        assert transport.posts == 1
        assert len(transport.events) == 1


def test_delete_task_removes_the_google_event(tmp_path):
    transport = SplitBrainTransport()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    settings = _live_settings(tmp_path)
    from tafo.app import create_app

    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        task = add_task(client, title="Linked sample")
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Deleting the task must cancel the Google event.",
                "payload": {
                    "task_id": task["id"],
                    "domain": "work",
                    "event_key": "evt_delete_task",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        ).json()
        approved = client.post(
            f"/api/decisions/{proposal['id']}/approve",
            json={"expected_version": proposal["version"], "confirmed": True},
        )
        assert approved.status_code == 200, approved.text
        assert transport.posts == 1
        deleted = client.post(
            f"/api/tasks/{task['id']}/delete",
            json={"expected_version": task["version"]},
        )
        assert deleted.status_code == 200, deleted.text
        assert transport.deletes == 1
        assert transport.events == {}
        blocks = client.get("/api/calendar/blocks").json()["blocks"]
        assert blocks[0]["status"] == "cancelled"
        assert client.get(f"/api/tasks/{task['id']}").status_code == 404


def test_non_loopback_host_is_rejected(client):
    add_task(client, title="Host sample")
    denied = client.get("/api/admin/export", headers={"Host": "evil.example"})
    assert denied.status_code == 400
    assert denied.json()["detail"]["code"] == "bad_host"
    assert "Host sample" not in denied.text
    assert client.get("/api/health").status_code == 200
    assert host_is_loopback("127.0.0.1:8787")
    assert host_is_loopback("[::1]:8787")
    assert host_is_loopback("localhost")
    assert host_is_loopback("evil.example") is False


def test_credentials_file_is_written_mode_0600(tmp_path):
    from tafo.calendar_adapter import restrict_private_file, write_private_text

    path = tmp_path / "token.json"
    path.write_text('{"token": "fake"}', encoding="utf-8")
    path.chmod(0o644)
    restrict_private_file(path)
    assert path.stat().st_mode & 0o777 == 0o600
    write_private_text(path, '{"token": "refreshed"}')
    mode = path.stat().st_mode & 0o777
    assert mode == 0o600
    assert path.read_text(encoding="utf-8") == '{"token": "refreshed"}'


def test_idempotency_key_rejects_a_different_body(client):
    task = add_task(client, title="Outline sample", domain="work", on_today=False)
    first = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "task_change",
            "explanation": "Rename the sample.",
            "idempotency_key": "agent-title-1",
            "payload": {
                "op": "update",
                "task_id": task["id"],
                "changes": {"title": "First title"},
            },
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "task_change",
            "explanation": "Rename the sample.",
            "idempotency_key": "agent-title-1",
            "payload": {
                "op": "update",
                "task_id": task["id"],
                "changes": {"title": "Second title"},
            },
        },
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "idempotency_conflict"
    assert first.json()["payload"]["changes"]["title"] == "First title"
    replay = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "task_change",
            "explanation": "Rename the sample.",
            "idempotency_key": "agent-title-1",
            "payload": {
                "op": "update",
                "task_id": task["id"],
                "changes": {"title": "First title"},
            },
        },
    )
    assert replay.status_code == 200
    assert replay.json()["id"] == first.json()["id"]


def test_stored_event_404_recreates_one_event(tmp_path):
    transport = SplitBrainTransport()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    settings = _live_settings(tmp_path)
    from tafo.app import create_app

    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        proposal = _proposal(client, "evt_missing_id")
        approved = client.post(
            f"/api/decisions/{proposal['id']}/approve",
            json={"expected_version": proposal["version"], "confirmed": True},
        )
        assert approved.status_code == 200, approved.text
        assert transport.posts == 1
        stored_id = approved.json()["outbox"]["google_event_id"]
        transport.events.pop(stored_id)
        transport.patch_status = 404
        conn = connect(settings.db_path)
        conn.execute(
            "UPDATE outbox_operations SET status = 'failed', last_error = 'gone' WHERE id = ?",
            (approved.json()["outbox"]["id"],),
        )
        conn.close()
        retried = client.post(f"/api/calendar/outbox/{approved.json()['outbox']['id']}/retry")
        assert retried.status_code == 200, retried.text
        body = retried.json()
        assert body["operation"]["status"] == "synced"
        assert transport.posts == 2
        assert len(transport.events) == 1
        assert body["operation"]["google_event_id"] in transport.events


def test_failed_live_retry_waits_on_retry_after(tmp_path, monkeypatch):
    transport = SplitBrainTransport()
    transport.fail_posts = 1
    transport.retry_after = 1.25
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    settings = _live_settings(tmp_path)
    from tafo.app import create_app

    sleeps: list[float] = []
    monkeypatch.setattr("tafo.outbox.time.sleep", lambda seconds: sleeps.append(seconds))
    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        proposal = _proposal(client, "evt_backoff")
        first = client.post(
            f"/api/decisions/{proposal['id']}/approve",
            json={"expected_version": proposal["version"], "confirmed": True},
        )
        assert first.status_code == 200, first.text
        assert first.json()["outbox"]["status"] == "failed"
        assert 1.25 not in sleeps
        retried = client.post(f"/api/calendar/outbox/{first.json()['outbox']['id']}/retry")
        assert retried.status_code == 200, retried.text
        assert retried.json()["operation"]["status"] == "synced"
        assert 1.25 in sleeps


def test_delete_subtask_checks_version(client):
    task = add_task(client, title="Checklist sample")
    created = client.post(f"/api/tasks/{task['id']}/subtasks", json={"title": "Step"})
    assert created.status_code == 201, created.text
    item = created.json()
    stale = client.delete(f"/api/subtasks/{item['id']}", params={"expected_version": item["version"] + 3})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "version_conflict"
    still = client.get(f"/api/tasks/{task['id']}").json()
    assert len(still["subtasks"]) == 1
    removed = client.delete(f"/api/subtasks/{item['id']}", params={"expected_version": item["version"]})
    assert removed.status_code == 200, removed.text
    assert client.get(f"/api/tasks/{task['id']}").json()["subtasks"] == []


class NeighborClash:
    def __init__(self, conn) -> None:
        self._conn = conn
        self.order_updates = 0

    def execute(self, sql, params=()):
        if "UPDATE tasks" in sql and "sort_order" in sql:
            self.order_updates += 1
            if self.order_updates >= 2 and "version = ?" in sql.split("WHERE", 1)[-1]:
                class Clash:
                    rowcount = 0

                return Clash()
        return self._conn.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def test_move_task_checks_neighbor_version(settings):
    from tafo.migrate import apply_migrations

    conn = connect(settings.db_path)
    try:
        apply_migrations(conn)
    finally:
        conn.close()
    with session(settings.db_path) as conn:
        first = create_task(conn, {"title": "First", "domain": "work", "on_today": True}, actor="human")
        create_task(conn, {"title": "Second", "domain": "work", "on_today": True}, actor="human")
    with session(settings.db_path) as conn:
        with pytest.raises(Problem) as caught:
            move_task(
                NeighborClash(conn),
                first["id"],
                direction="down",
                view="all",
                scope="all",
                expected_version=first["version"],
                actor="human",
            )
    assert caught.value.status == 409
    assert caught.value.code == "version_conflict"


def test_snapshot_versions_is_gone():
    import tafo.availability as availability

    assert not hasattr(availability, "snapshot_versions")
