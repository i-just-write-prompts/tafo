"""Approve and deny stay on the local UI session. Agents can still propose."""

from datetime import timedelta

from tafo.timeutil import local_naive_to_utc
from zoneinfo import ZoneInfo

from tests.conftest import add_task


def _agent_block(client) -> dict:
    created = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "Hold an hour for a personal errand.",
            "idempotency_key": "agent-approve-scope-1",
            "payload": {
                "domain": "personal",
                "starts_at": "2026-11-08T15:00:00Z",
                "ends_at": "2026-11-08T16:00:00Z",
            },
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


def _still_pending(client, proposal: dict) -> None:
    fresh = client.get(f"/api/hermes/proposals/{proposal['id']}").json()
    assert fresh["status"] == "pending"
    assert fresh["version"] == proposal["version"]


def test_agent_and_api_cannot_approve_or_deny(client):
    proposal = _agent_block(client)
    token = client.app.state.ui_session_token
    assert token
    client.inject_ui_session = False

    agent = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        headers={"X-TAFO-Actor": "agent", "X-TAFO-UI-Session": token},
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert agent.status_code == 403
    _still_pending(client, proposal)

    missing = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert missing.status_code == 403
    assert missing.json()["detail"]["code"] == "ui_session_required"
    _still_pending(client, proposal)

    denied = client.post(
        f"/api/decisions/{proposal['id']}/reject",
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert denied.status_code == 403
    _still_pending(client, proposal)

    wrong = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        headers={"X-TAFO-UI-Session": "not-the-session"},
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert wrong.status_code == 403
    _still_pending(client, proposal)

    contract = client.get("/api/hermes/contract").json()
    dumped = str(contract).lower()
    assert "ui_session" not in dumped
    assert "x-tafo-ui-session" not in dumped

    allowed = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        headers={"X-TAFO-UI-Session": token},
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["proposal"]["status"] == "approved"


def test_meta_hands_the_session_to_the_page_only(client):
    meta = client.get("/api/meta").json()
    assert meta["ui_session_token"] == client.app.state.ui_session_token
    assert meta["human_edits_auto_approve"] is True
    contract = client.get("/api/hermes/contract").json()
    assert "ui_session_token" not in contract


def test_display_zone_stores_dst_as_real_utc():
    zone = ZoneInfo("America/Indianapolis")
    spring_before = local_naive_to_utc("2027-03-14T01:30", "America/Indianapolis")
    spring_after = local_naive_to_utc("2027-03-14T03:30", "America/Indianapolis")
    assert spring_after - spring_before == timedelta(hours=1)
    assert spring_before.astimezone(zone).strftime("%z") == "-0500"
    assert spring_after.astimezone(zone).strftime("%z") == "-0400"
    fall_start = local_naive_to_utc("2027-11-07T00:30", "America/Indianapolis")
    fall_end = local_naive_to_utc("2027-11-07T02:30", "America/Indianapolis")
    assert fall_end - fall_start == timedelta(hours=3)
    assert fall_start.astimezone(zone).strftime("%z") == "-0400"
    assert fall_end.astimezone(zone).strftime("%z") == "-0500"


def test_human_schedule_still_approves_with_the_session(client):
    task = add_task(client, title="Water the balcony herbs", domain="home", estimate_hours=0.25, on_today=False)
    created = client.post(
        "/api/hermes/proposals",
        json={
            "source": "plan",
            "source_kind": "human",
            "kind": "calendar_block",
            "explanation": "Scheduled from the plan.",
            "idempotency_key": "plan.block.session-check",
            "payload": {
                "task_id": task["id"],
                "domain": "home",
                "starts_at": "2026-11-09T14:00:00Z",
                "ends_at": "2026-11-09T14:15:00Z",
                "allow_custom_title": True,
                "title": task["title"],
            },
        },
    )
    assert created.status_code == 201, created.text
    approved = client.post(
        f"/api/decisions/{created.json()['id']}/approve",
        json={"expected_version": created.json()["version"], "confirmed": True},
    )
    assert approved.status_code == 200, approved.text
    block = approved.json()["block"]
    assert block["title"] == "Water the balcony herbs"
    assert block["sync_state"] == "simulated"
