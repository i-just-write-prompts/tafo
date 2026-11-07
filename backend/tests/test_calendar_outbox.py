import threading
import time
import urllib.parse

import pytest
import urllib.request
from datetime import timedelta

from tafo.app import create_app
from tafo.calendar_adapter import OUTLOOK_GAP, AdapterResult, GoogleCalendarAdapter, TransportError
from tafo.config import Settings
from tafo.demo_schedule import DEMO_MIRROR_KEY, demo_fixed_span
from tafo.timeutil import fmt_utc
from fastapi.testclient import TestClient

from tests.conftest import add_task, approve


class ScriptTransport:
    def __init__(self) -> None:
        self.fail_patches = 1
        self.calls: list[dict] = []
        self.events: dict[str, dict] = {}

    def request(self, method, url, *, params=None, json_body=None, headers=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json_body})
        assert headers["Authorization"] == "Bearer test-token"
        if method == "GET" and params and "privateExtendedProperty" in params:
            key = params["privateExtendedProperty"].split("=", 1)[1]
            items = [
                event
                for event in self.events.values()
                if event.get("extendedProperties", {}).get("private", {}).get("tafoEventKey") == key
            ]
            return {"items": items}
        if method == "GET":
            return {"items": list(self.events.values())}
        if method == "POST" and url.endswith("/events"):
            event_id = f"g{len(self.events) + 1}"
            event = {"id": event_id, **(json_body or {})}
            self.events[event_id] = event
            return event
        if method == "POST" and url.endswith("/freeBusy"):
            return {"calendars": {"cal-demo": {"busy": []}}}
        if method == "PATCH":
            if self.fail_patches > 0:
                self.fail_patches -= 1
                raise TransportError(500, "invite failed")
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            self.events[event_id].update(json_body or {})
            return self.events[event_id]
        if method == "DELETE":
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            self.events.pop(event_id, None)
            return {}
        raise AssertionError(f"unexpected {method} {url}")


class RecordingAdapter:
    mode = "live"

    def __init__(self) -> None:
        self.reads = 0
        self.writes = 0

    def read_busy(self, start, end):
        del start, end
        self.reads += 1
        from tafo.calendar_adapter import BusyInterval

        return [
            BusyInterval(
                source="google",
                external_id="g-busy",
                starts_at="2026-11-12T15:00:00Z",
                ends_at="2026-11-12T16:00:00Z",
                summary="Busy",
            )
        ]

    def create_block(self, event_key, payload, known_google_id=None):
        del event_key, payload, known_google_id
        self.writes += 1
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id="g-recorded",
            honest_label="Synced to Google Calendar.",
            steps=[],
            mode="live",
        )

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


class LiarAdapter:
    mode = "live"

    def read_busy(self, start, end):
        del start, end
        return []

    def _lie(self):
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id="g-liar",
            honest_label="Synced to Google Calendar.",
            steps=[],
            mode="live",
        )

    def create_block(self, event_key, payload, known_google_id=None):
        del event_key, payload, known_google_id
        return self._lie()

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


def _live_settings(tmp_path) -> Settings:
    return Settings(
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


def test_partial_invite_retry_does_not_duplicate_the_google_event(tmp_path):
    transport = ScriptTransport()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    app = create_app(_live_settings(tmp_path), adapter=adapter)
    with TestClient(app) as client:
        task = add_task(client, title="Sample focus", domain="work")
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Hold a generic focus block and invite the configured address.",
                "payload": {
                    "task_id": task["id"],
                    "domain": "work",
                    "event_key": "evt_retry_sample",
                    "starts_at": "2026-11-11T15:00:00Z",
                    "ends_at": "2026-11-11T16:00:00Z",
                    "invite_work_email": True,
                    "work_email": "other@corp.example",
                },
            },
        ).json()
        assert "other@corp.example" not in str(proposal)
        first = approve(client, proposal)
        assert first["outbox"]["status"] == "partial"
        assert first["outbox"]["google_event_id"] == "g1"
        assert first["block"]["sync_state"] == "partial"
        assert any(step["name"] == "invite_work_email" and step["ok"] is False for step in first["outbox"]["result"]["steps"])
        assert "not fully synced" in first["outbox"]["honest_label"].lower()
        posts = [call for call in transport.calls if call["method"] == "POST" and call["url"].endswith("/events")]
        assert len(posts) == 1
        retried = client.post(f"/api/calendar/outbox/{first['outbox']['id']}/retry")
        assert retried.status_code == 200, retried.text
        body = retried.json()
        assert body["operation"]["status"] == "synced"
        assert body["operation"]["google_event_id"] == "g1"
        assert body["operation"]["attempt_count"] == 2
        posts = [call for call in transport.calls if call["method"] == "POST" and call["url"].endswith("/events")]
        assert len(posts) == 1
        assert len(transport.events) == 1
        invite_patches = [
            call
            for call in transport.calls
            if call["method"] == "PATCH" and call["params"] and call["params"].get("sendUpdates") == "all"
        ]
        assert invite_patches[-1]["json"]["attendees"] == [{"email": "worker@example.com"}]
        operations = client.get("/api/calendar/outbox").json()["operations"]
        assert len(operations) == 1


def test_live_read_happens_before_approval_and_does_not_move_the_request(tmp_path):
    adapter = RecordingAdapter()
    app = create_app(_live_settings(tmp_path), adapter=adapter)
    with TestClient(app) as client:
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "sample-agent",
                "source_kind": "human",
                "kind": "calendar_block",
                "explanation": "Ask for the overlapping hour without moving it.",
                "payload": {
                    "domain": "work",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        )
        assert proposal.status_code == 201, proposal.text
        body = proposal.json()
        assert adapter.reads == 1
        assert adapter.writes == 0
        assert body["payload"]["starts_at"] == "2026-11-12T15:00:00Z"
        assert body["availability"]["external_busy"][0]["external_id"] == "g-busy"
        assert body["availability"]["outlook_gap"] == OUTLOOK_GAP
        assert client.get("/api/calendar/blocks").json()["blocks"] == []
        approved = approve(client, body)
        assert adapter.writes == 1
        assert approved["block"]["sync_state"] == "synced"
        assert approved["block"]["starts_at"] == "2026-11-12T15:00:00Z"


def test_demo_mode_refuses_a_synced_looking_result(tmp_path, settings):
    app = create_app(settings, adapter=LiarAdapter())
    with TestClient(app) as client:
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Demo must not keep a fake Google id.",
                "payload": {
                    "domain": "home",
                    "starts_at": "2026-11-12T18:00:00Z",
                    "ends_at": "2026-11-12T19:00:00Z",
                },
            },
        ).json()
        decision = approve(client, proposal)
        assert decision["outbox"]["status"] == "failed"
        assert decision["outbox"]["mode"] == "demo"
        assert decision["outbox"]["google_event_id"] is None
        assert "not synced" in decision["outbox"]["honest_label"].lower()
        assert decision["block"] is None
        assert client.get("/api/calendar/blocks").json()["blocks"] == []


def test_demo_and_unconfigured_live_do_not_call_the_network(tmp_path, monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("network was called")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    demo = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path / "demo",
        db_path=tmp_path / "demo" / "tafo.sqlite",
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file=str(tmp_path / "unused.json"),
        google_calendar_id="primary",
        work_invite_email="worker@example.com",
        allow_lan=False,
        seed_demo=False,
    )
    with TestClient(create_app(demo)) as client:
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Dry run only.",
                "payload": {
                    "domain": "personal",
                    "starts_at": "2026-11-13T15:00:00Z",
                    "ends_at": "2026-11-13T16:00:00Z",
                },
            },
        ).json()
        decision = approve(client, proposal)
        assert decision["outbox"]["status"] == "simulated"
        meta = client.get("/api/meta").json()
        assert meta["sync_label"].lower().count("not synced") == 1
        assert "worker@example.com" not in str(meta)

    live = _live_settings(tmp_path / "bare")
    live = Settings(
        host=live.host,
        port=live.port,
        data_dir=tmp_path / "bare",
        db_path=tmp_path / "bare" / "tafo.sqlite",
        display_timezone=live.display_timezone,
        calendar_mode="live",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
    )
    with TestClient(create_app(live)) as client:
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Live mode without credentials must fail closed.",
                "payload": {
                    "domain": "work",
                    "starts_at": "2026-11-13T15:00:00Z",
                    "ends_at": "2026-11-13T16:00:00Z",
                },
            },
        ).json()
        assert proposal["availability"]["read_source"] == "unconfigured"
        assert proposal["availability"]["read_error"]
        assert "not" in proposal["availability"]["outlook_gap"].lower()
        decision = approve(client, proposal)
        assert decision["outbox"]["status"] == "failed"
        assert decision["outbox"]["result"]["sync_state"] == "not_synced"
        assert "not synced" in decision["outbox"]["honest_label"].lower()
        assert decision["block"] is None


def test_fixed_appointments_do_not_move_without_acknowledgement(client):
    start, end = demo_fixed_span()
    moved_end = end + timedelta(hours=1)
    created = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "kind": "calendar_block",
            "explanation": "Sample fixed hold.",
            "payload": {
                "domain": "personal",
                "event_key": "evt_fixed_sample",
                "starts_at": fmt_utc(start),
                "ends_at": fmt_utc(end),
                "fixed": True,
            },
        },
    ).json()
    approved = approve(client, created)
    assert approved["block"]["fixed"] is True
    original = approved["block"]["starts_at"]
    update = client.post(
        "/api/hermes/proposals",
        json={
            "source": "sample-agent",
            "source_kind": "human",
            "kind": "calendar_update",
            "explanation": "Try to slide the fixed sample.",
            "payload": {
                "event_key": "evt_fixed_sample",
                "starts_at": fmt_utc(end),
                "ends_at": fmt_utc(moved_end),
            },
        },
    ).json()
    assert update["payload"]["touches_fixed"] is True
    assert client.get("/api/calendar/blocks").json()["blocks"][0]["starts_at"] == original
    denied = client.post(
        f"/api/decisions/{update['id']}/approve",
        json={"expected_version": update["version"], "confirmed": True},
    )
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "fixed_block_requires_acknowledgement"
    assert client.get("/api/calendar/blocks").json()["blocks"][0]["starts_at"] == original
    allowed = approve(client, update, acknowledge_fixed_move=True)
    assert allowed["block"]["starts_at"] == fmt_utc(end)
    assert allowed["block"]["sync_state"] == "simulated"


def test_mirrored_blocks_are_deduped_and_outlook_gap_is_explicit(client):
    before = client.get(
        "/api/calendar/availability",
        params={"start": "2026-11-06T00:00:00Z", "end": "2026-11-20T00:00:00Z"},
    ).json()
    assert before["conflict_free"] is False
    assert before["outlook_gap"] == OUTLOOK_GAP
    assert any(item["tafo_event_key"] == DEMO_MIRROR_KEY for item in before["orphan_app_blocks"])
    assert all(item["tafo_event_key"] != DEMO_MIRROR_KEY for item in before["external_busy"])
    assert any(item["source"] == "demo_fixture" for item in before["external_busy"])
    proposal = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "kind": "calendar_block",
            "explanation": "Adopt the demo mirror key.",
            "payload": {
                "domain": "personal",
                "event_key": DEMO_MIRROR_KEY,
                "starts_at": "2026-11-12T14:00:00Z",
                "ends_at": "2026-11-12T15:00:00Z",
            },
        },
    ).json()
    approve(client, proposal)
    after = client.get(
        "/api/calendar/availability",
        params={"start": "2026-11-06T00:00:00Z", "end": "2026-11-20T00:00:00Z"},
    ).json()
    assert any(item["tafo_event_key"] == DEMO_MIRROR_KEY for item in after["suppressed_mirrors"])
    assert all(item.get("tafo_event_key") != DEMO_MIRROR_KEY for item in after["external_busy"])
    assert all(item.get("tafo_event_key") != DEMO_MIRROR_KEY for item in after["orphan_app_blocks"])
    assert len([block for block in after["local_blocks"] if block["id"] == DEMO_MIRROR_KEY]) == 1


def test_suggestion_does_not_rewrite_fixed_blocks(client):
    start, end = demo_fixed_span()
    created = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "kind": "calendar_block",
            "explanation": "Fixed sample inside the week.",
            "payload": {
                "domain": "personal",
                "event_key": "evt_fixed_suggest",
                "starts_at": fmt_utc(start),
                "ends_at": fmt_utc(end),
                "fixed": True,
            },
        },
    ).json()
    approved = approve(client, created)
    suggestion = client.get("/api/calendar/suggestion", params={"duration_minutes": 60})
    assert suggestion.status_code == 200, suggestion.text
    body = suggestion.json()
    assert body["moved_existing_events"] is False
    assert body["outlook_gap"] == OUTLOOK_GAP
    slot_start = body["starts_at"]
    slot_end = body["ends_at"]
    assert not (slot_start < approved["block"]["ends_at"] and approved["block"]["starts_at"] < slot_end)
    again = client.get("/api/calendar/blocks").json()["blocks"][0]
    assert again["starts_at"] == approved["block"]["starts_at"]
    assert again["version"] == approved["block"]["version"]


class LookupLossTransport:
    """Invite fails once, then lookup raises, then lookup returns no items."""

    def __init__(self) -> None:
        self.fail_patches = 1
        self.lookup = "find"
        self.posts = 0
        self.events: dict[str, dict] = {}

    def request(self, method, url, *, params=None, json_body=None, headers=None):
        assert headers["Authorization"] == "Bearer test-token"
        if method == "GET" and params and "privateExtendedProperty" in params:
            if self.lookup == "raise":
                raise TransportError(503, "lookup unavailable")
            if self.lookup == "empty":
                return {"items": []}
            key = params["privateExtendedProperty"].split("=", 1)[1]
            items = [
                event
                for event in self.events.values()
                if event.get("extendedProperties", {}).get("private", {}).get("tafoEventKey") == key
            ]
            return {"items": items}
        if method == "GET":
            return {"items": list(self.events.values())}
        if method == "POST" and url.endswith("/events"):
            self.posts += 1
            event_id = f"g{self.posts}"
            event = {"id": event_id, **(json_body or {})}
            self.events[event_id] = event
            return event
        if method == "POST" and url.endswith("/freeBusy"):
            return {"calendars": {"cal-demo": {"busy": []}}}
        if method == "PATCH":
            if self.fail_patches > 0:
                self.fail_patches -= 1
                raise TransportError(500, "invite failed")
            event_id = urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            self.events[event_id].update(json_body or {})
            return self.events[event_id]
        if method == "DELETE":
            return {}
        raise AssertionError(f"unexpected {method} {url}")


def test_failed_lookup_keeps_google_id_and_empty_lookup_does_not_duplicate(tmp_path):
    transport = LookupLossTransport()
    adapter = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")
    app = create_app(_live_settings(tmp_path), adapter=adapter)
    with TestClient(app) as client:
        proposal = client.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Partial invite, then a lookup failure, then an empty lookup.",
                "payload": {
                    "domain": "work",
                    "event_key": "evt_precise1",
                    "starts_at": "2026-11-11T15:00:00Z",
                    "ends_at": "2026-11-11T16:00:00Z",
                    "invite_work_email": True,
                },
            },
        ).json()
        first = approve(client, proposal)
        assert first["outbox"]["status"] == "partial"
        assert first["outbox"]["google_event_id"] == "g1"
        assert first["block"]["google_event_id"] == "g1"
        assert transport.posts == 1

        transport.lookup = "raise"
        missed = client.post(f"/api/calendar/outbox/{first['outbox']['id']}/retry")
        assert missed.status_code == 200, missed.text
        missed_body = missed.json()
        assert missed_body["operation"]["status"] == "failed"
        assert missed_body["operation"]["google_event_id"] == "g1"
        assert missed_body["operation"]["attempt_count"] == 2
        assert missed_body["block"]["google_event_id"] == "g1"
        assert "kept" in missed_body["operation"]["honest_label"].lower()
        assert transport.posts == 1
        assert list(transport.events) == ["g1"]

        transport.lookup = "empty"
        recovered = client.post(f"/api/calendar/outbox/{first['outbox']['id']}/retry")
        assert recovered.status_code == 200, recovered.text
        recovered_body = recovered.json()
        assert recovered_body["operation"]["google_event_id"] == "g1"
        assert recovered_body["operation"]["status"] == "synced"
        assert recovered_body["block"]["google_event_id"] == "g1"
        assert transport.posts == 1
        assert list(transport.events) == ["g1"]


class SlowCreateAdapter:
    mode = "live"

    def __init__(self) -> None:
        self.creates = 0

    def read_busy(self, start, end):
        del start, end
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        del event_key, payload, known_google_id
        self.creates += 1
        time.sleep(6)
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id="g-slow",
            honest_label="Synced to Google Calendar.",
            steps=[],
            mode="live",
        )

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


def test_slow_calendar_write_leaves_task_reads_available(tmp_path):
    adapter = SlowCreateAdapter()
    app = create_app(_live_settings(tmp_path), adapter=adapter)
    holder: dict[str, int] = {}

    def read_tasks(reader: TestClient) -> None:
        time.sleep(0.4)
        response = reader.get("/api/tasks")
        holder["status"] = response.status_code

    with TestClient(app) as writer, TestClient(app) as reader:
        proposal = writer.post(
            "/api/hermes/proposals",
            json={
                "source": "tafo-ui",
                "kind": "calendar_block",
                "explanation": "Slow adapter must not lock task reads.",
                "payload": {
                    "domain": "work",
                    "event_key": "evt_slow1",
                    "starts_at": "2026-11-12T15:00:00Z",
                    "ends_at": "2026-11-12T16:00:00Z",
                },
            },
        ).json()
        thread = threading.Thread(target=read_tasks, args=(reader,))
        thread.start()
        approved = writer.post(
            f"/api/decisions/{proposal['id']}/approve",
            json={"expected_version": proposal["version"], "confirmed": True},
        )
        thread.join(timeout=12)
        assert thread.is_alive() is False
        assert approved.status_code == 200, approved.text
        assert holder["status"] == 200
        assert adapter.creates == 1
        assert approved.json()["outbox"]["google_event_id"] == "g-slow"


class SimulatedCrash(BaseException):
    """Stands in for a process death inside the calendar call."""


class CrashThenReconcile:
    mode = "live"

    def __init__(self, transport: LookupLossTransport) -> None:
        self.calls = 0
        self.inner = GoogleCalendarAdapter(transport, "cal-demo", "worker@example.com", token="test-token")

    def read_busy(self, start, end):
        del start, end
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        self.calls += 1
        if self.calls == 1:
            raise SimulatedCrash("simulated death inside create_block")
        return self.inner.create_block(event_key, payload, known_google_id)

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


def _proposal(client: TestClient, event_key: str) -> dict:
    response = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "kind": "calendar_block",
            "explanation": "Crash recovery sample.",
            "payload": {
                "domain": "work",
                "event_key": event_key,
                "starts_at": "2026-11-12T15:00:00Z",
                "ends_at": "2026-11-12T16:00:00Z",
            },
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_dead_processing_claim_is_reclaimed_and_reconciles_remote_event(tmp_path):
    from tafo.db import connect, session
    from tafo.decisions import stage_approval
    from tafo.outbox import PROCESSING, process_outbox

    transport = LookupLossTransport()
    transport.fail_patches = 0
    adapter = CrashThenReconcile(transport)
    settings = _live_settings(tmp_path)
    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        proposal = _proposal(client, "evt_dead_claim")
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
        outbox_id = staged["outbox_id"]
        with pytest.raises(SimulatedCrash):
            process_outbox(settings, adapter, outbox_id)
        stuck = client.get("/api/calendar/outbox").json()["operations"][0]
        assert stuck["status"] == "pending"
        assert stuck["attempt_count"] == 1
        assert stuck["google_event_id"] is None
        assert str(stuck["last_error"]).startswith(PROCESSING)
        assert transport.posts == 0

        conn = connect(settings.db_path)
        conn.execute(
            "UPDATE outbox_operations SET last_error = ? WHERE id = ?",
            (PROCESSING, outbox_id),
        )
        conn.close()
        transport.events["g-prior"] = {
            "id": "g-prior",
            "extendedProperties": {"private": {"tafoEventKey": "evt_dead_claim"}},
        }
        started = time.monotonic()
        recovered = client.post(f"/api/calendar/outbox/{outbox_id}/retry")
        elapsed = time.monotonic() - started
        assert elapsed < 2, elapsed
        assert recovered.status_code == 200, recovered.text
        body = recovered.json()
        assert body["operation"]["status"] == "synced"
        assert body["operation"]["google_event_id"] == "g-prior"
        assert body["block"]["google_event_id"] == "g-prior"
        assert transport.posts == 0
        assert list(transport.events) == ["g-prior"]
        assert adapter.calls == 2


class GateAdapter:
    mode = "live"

    def __init__(self) -> None:
        self.calls = 0
        self.entered = threading.Event()
        self.release = threading.Event()

    def read_busy(self, start, end):
        del start, end
        return []

    def create_block(self, event_key, payload, known_google_id=None):
        del event_key, payload, known_google_id
        self.calls += 1
        self.entered.set()
        assert self.release.wait(5)
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id="g-gate",
            honest_label="Synced to Google Calendar.",
            steps=[],
            mode="live",
        )

    def update_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key, payload, known_google_id=None):
        return self.create_block(event_key, payload, known_google_id)


def test_baseexception_inside_create_retries_immediately(tmp_path):
    from tafo.decisions import stage_approval
    from tafo.db import session
    from tafo.outbox import process_outbox

    transport = LookupLossTransport()
    transport.fail_patches = 0
    adapter = CrashThenReconcile(transport)
    settings = _live_settings(tmp_path / "immediate")
    app = create_app(settings, adapter=adapter)
    with TestClient(app) as client:
        proposal = _proposal(client, "evt_immediate_retry")
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
        started = time.monotonic()
        recovered = process_outbox(settings, adapter, staged["outbox_id"])
        assert time.monotonic() - started < 2
        assert recovered["status"] == "synced"
        assert recovered["google_event_id"] == "g1"
        assert transport.posts == 1
        assert adapter.calls == 2


def test_live_claim_is_not_stolen_by_a_concurrent_attempt(tmp_path):
    adapter = GateAdapter()
    app = create_app(_live_settings(tmp_path), adapter=adapter)
    holder: dict[str, object] = {}
    with TestClient(app) as first, TestClient(app) as second:
        proposal = _proposal(first, "evt_live_claim")

        def approve() -> None:
            holder["first"] = first.post(
                f"/api/decisions/{proposal['id']}/approve",
                json={"expected_version": proposal["version"], "confirmed": True},
            )

        def retry_while_busy() -> None:
            operation_id = holder["outbox_id"]
            holder["second"] = second.post(f"/api/calendar/outbox/{operation_id}/retry")

        worker = threading.Thread(target=approve)
        worker.start()
        assert adapter.entered.wait(3)
        assert adapter.calls == 1
        stuck = first.get("/api/calendar/outbox").json()["operations"][0]
        holder["outbox_id"] = stuck["id"]
        waiter = threading.Thread(target=retry_while_busy)
        waiter.start()
        time.sleep(0.4)
        assert adapter.calls == 1
        assert waiter.is_alive()
        adapter.release.set()
        worker.join(5)
        waiter.join(5)
        assert adapter.calls == 1
        assert holder["first"].status_code == 200
        second_response = holder["second"]
        assert second_response.status_code == 200
        assert second_response.json()["operation"]["google_event_id"] == "g-gate"
        assert second_response.json()["operation"]["id"] == stuck["id"]
